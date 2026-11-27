//! QuitFind: client for FMD server protocol v2 and the QuitFind device register
//! (docs/apparatenregister.md). Logs in to the owner account, reads the encrypted register and
//! fetches the decrypted locations of every device. Blocking: run it in its own thread.
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::time::Duration;

fn hu(u: &str) -> [u8; 32] {
    Sha256::digest(u.as_bytes()).into()
}

/// HKDF-SHA256 (empty salt) with info = context || SHA256(username), as in FMD v2.
fn hkdf32(ikm: &[u8], ctx: &str, user: &str) -> [u8; 32] {
    let mut k = [0u8; 32];
    Hkdf::<Sha256>::new(None, ikm).expand(&[ctx.as_bytes(), &hu(user)].concat(), &mut k).expect("32-byte HKDF output");
    k
}

/// K_pwk: Argon2id (128 MiB, t=1, p=4) over "fmd_v2_password" || SHA256(user) || password.
pub fn password_key(user: &str, password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(131072, 1, 4, Some(32)).map_err(|e| e.to_string())?;
    let mut k = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(&[b"fmd_v2_password".as_slice(), &hu(user), password.as_bytes()].concat(), salt, &mut k)
        .map_err(|e| e.to_string())?;
    Ok(k)
}

/// AES-256-GCM, blob = IV(12) || ciphertext || tag(16).
fn open(key: &[u8], aad: &[u8], blob: &[u8]) -> Option<Vec<u8>> {
    if blob.len() < 28 {
        return None;
    }
    let (iv, ct) = blob.split_at(12);
    Aes256Gcm::new_from_slice(key).ok()?.decrypt(Nonce::from_slice(iv), Payload { msg: ct, aad }).ok()
}

/// One v2 data item: DEK wrapped by the KEK, data by the DEK; type, user, id and time are bound in.
fn open_item(kek: &[u8], typ: &str, user: &str, id: &[u8], ms: u64, blob: &[u8]) -> Option<Vec<u8>> {
    if blob.len() < 88 {
        return None;
    }
    let s = [typ.as_bytes(), &hu(user), id, &ms.to_be_bytes()].concat();
    let dek = open(kek, &[b"fmd_v2_dek_".as_slice(), &s].concat(), &blob[..60])?;
    open(&dek, &[b"fmd_v2_data_".as_slice(), &s].concat(), &blob[60..])
}

#[derive(Debug)]
pub struct Error {
    pub status: u16, // 0 = network or format
    pub text: String,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}

fn err(text: impl Into<String>) -> Error {
    Error { status: 0, text: text.into() }
}

struct Session {
    user: String,
    token: String,
    master: [u8; 32],
}

struct Client {
    base: String,
    http: reqwest::blocking::Client,
}

impl Client {
    fn new(server: &str) -> Result<Self, Error> {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| err(e.to_string()))?;
        Ok(Client { base: format!("{}/api/v2", server.trim().trim_end_matches('/')), http })
    }

    fn call(&self, post: Option<Value>, path: &str, token: Option<&str>) -> Result<Value, Error> {
        let mut req = match &post {
            Some(body) => self.http.post(self.base.clone() + path).json(body),
            None => self.http.get(self.base.clone() + path),
        };
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let r = req.send().map_err(|e| err(e.to_string()))?;
        let status = r.status().as_u16();
        let text = r.text().unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(Error { status, text: format!("HTTP {status} {}", text.trim().chars().take(120).collect::<String>()) });
        }
        if text.trim().is_empty() { Ok(json!({})) } else { serde_json::from_str(&text).map_err(|e| err(e.to_string())) }
    }

    fn login_pwk(&self, user: &str, pwk: &[u8]) -> Result<Session, Error> {
        let auth = hkdf32(pwk, "fmd_v2_auth", user);
        let premaster = hkdf32(pwk, "fmd_v2_premaster", user);
        let r = self.call(
            Some(json!({"username": user, "passwordHash64": B64.encode(auth), "sessionDurationSeconds": 604800})),
            "/account/login",
            None,
        )?;
        let enc = B64.decode(r["encMasterKey64"].as_str().unwrap_or_default()).map_err(|e| err(e.to_string()))?;
        let master = open(&premaster, &[b"fmd_v2_master".as_slice(), &hu(user)].concat(), &enc)
            .ok_or_else(|| err("could not decrypt the master key"))?;
        let master: [u8; 32] = master.try_into().map_err(|_| err("bad master key size"))?;
        let token = r["accessToken"].as_str().unwrap_or_default().to_string();
        Ok(Session { user: user.into(), token, master })
    }

    fn items(&self, s: &Session, typ: &str) -> Result<Vec<(Vec<u8>, u64, Vec<u8>)>, Error> {
        let r = self.call(None, &format!("/data/{typ}"), Some(&s.token))?;
        Ok(r["items"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|it| {
                        let id = hex::decode(it["clientItemIdHex"].as_str()?).ok()?;
                        let ms = it["unixMillis"].as_u64()?;
                        let blob = B64.decode(it["ciphertext64"].as_str()?).ok()?;
                        Some((id, ms, blob))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
}

/// Verify the owner account once with its password (one Argon2 run) and return K_pwk as base64,
/// so later syncs never need the password again.
pub fn link(server: &str, user: &str, password: &str) -> Result<String, Error> {
    let c = Client::new(server)?;
    let r = c.call(None, &format!("/account/{user}/salt"), None)?;
    if r["protoVersion"].as_i64() != Some(2) {
        return Err(err("this account uses protocol v1; migrate it with the FMD app first"));
    }
    let salt = B64.decode(r["salt64"].as_str().unwrap_or_default()).map_err(|e| err(e.to_string()))?;
    let pwk = password_key(user, password, &salt).map_err(err)?;
    c.login_pwk(user, &pwk)?;
    Ok(B64.encode(pwk))
}

/// The linked owner account (stored with the other settings, file mode 0600).
#[derive(Serialize, Deserialize, Clone)]
pub struct QfConfig {
    pub server: String,
    pub user: String,
    pub pwk64: String,
}

pub struct RemoteFix {
    pub lat: f64,
    pub lon: f64,
    pub t: u64, // seconds
    pub acc: f32,
    pub provider: String,
    pub bat: Option<u8>,
    pub seen_by: Option<String>,
}

pub struct RemoteDevice {
    pub username: String,
    pub name: String,
    pub kind: String, // phone | tablet | laptop | pc | tag
    pub fixes: Vec<RemoteFix>, // oldest first
    pub error: Option<String>,
}

/// Device-controlled data: anything malformed is skipped.
fn parse_fix(pt: &[u8]) -> Option<RemoteFix> {
    let v: Value = serde_json::from_slice(pt).ok()?;
    let (lat, lon) = (v["lat"].as_f64()?, v["lon"].as_f64()?);
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    Some(RemoteFix {
        lat,
        lon,
        t: v["date"].as_u64()? / 1000,
        acc: v["accuracy"].as_f64().unwrap_or(25.0).clamp(1.0, 100_000.0) as f32,
        provider: v["provider"].as_str().unwrap_or("?").chars().take(20).collect(),
        bat: v["bat"].as_i64().filter(|b| (0..=100).contains(b)).map(|b| b as u8),
        seen_by: v["seenBy"].as_str().map(|s| s.chars().take(64).collect()),
    })
}

/// One sync round. `refused` keeps device accounts whose stored key the server refused (403/404/423):
/// they are not tried again, because 7 failed logins lock that account for 10 minutes.
pub fn sync(server: &str, user: &str, pwk64: &str, refused: &mut HashSet<String>) -> Result<Vec<RemoteDevice>, Error> {
    let c = Client::new(server)?;
    let pwk = B64.decode(pwk64).map_err(|e| err(e.to_string()))?;
    let owner = c.login_pwk(user, &pwk)?;
    let kek_device = hkdf32(&owner.master, "quitfind_v1_kek_device", &owner.user);
    let mut out = Vec::new();
    for (id, ms, blob) in c.items(&owner, "device")? {
        let Some(pt) = open_item(&kek_device, "device", &owner.user, &id, ms, &blob) else { continue };
        let Ok(e) = serde_json::from_slice::<Value>(&pt) else { continue };
        if e["kind"] != "device" {
            continue;
        }
        let (Some(du), Some(dpwk)) = (e["username"].as_str(), e["pwk64"].as_str()) else { continue };
        let mut dev = RemoteDevice {
            username: du.into(),
            name: e["name"].as_str().unwrap_or(du).chars().take(60).collect(),
            kind: e["type"].as_str().unwrap_or("phone").into(),
            fixes: Vec::new(),
            error: None,
        };
        if refused.contains(du) {
            dev.error = Some("key refused: link this device again on the web page".into());
            out.push(dev);
            continue;
        }
        let session = B64.decode(dpwk).map_err(|e| err(e.to_string())).and_then(|p| c.login_pwk(du, &p));
        match session {
            Ok(s) => {
                let kek = hkdf32(&s.master, "fmd_v2_kek_location", &s.user);
                match c.items(&s, "location") {
                    Ok(items) => {
                        dev.fixes = items.iter().filter_map(|(i, m, b)| open_item(&kek, "location", &s.user, i, *m, b)).filter_map(|p| parse_fix(&p)).collect();
                        dev.fixes.sort_by_key(|f| f.t);
                    }
                    Err(e) => dev.error = Some(e.text),
                }
            }
            Err(e) => {
                if matches!(e.status, 403 | 404 | 423) {
                    refused.insert(du.into());
                }
                dev.error = Some(e.text);
            }
        }
        out.push(dev);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors from tests/fmd_v2_vectors.mjs, shared with the web and Android code.
    #[test]
    fn password_and_hkdf_match_node() {
        let pwk = password_key("alice", "password", &[0x29; 16]).unwrap();
        assert_eq!(hex::encode(pwk), "274d05957daaba42e5af45ad27c3a69d9de4ee51b792d1b0d28fd270a62986cd");
        assert_eq!(hex::encode(hkdf32(&pwk, "fmd_v2_auth", "alice")), "67af4c1c0c96ef97d565a6f8080729d5620f5716d076b8f57c80855d4be112c4");
    }

    #[test]
    fn device_register_vector_and_binding() {
        let master: Vec<u8> = (0u8..32).collect();
        let kek = hkdf32(&master, "quitfind_v1_kek_device", "alice");
        assert_eq!(hex::encode(kek), "4624e3f1ed7d5d7641673eee34b0048abce26ae5886ee1f3a93102dc56440e6a");
        let id = hex::decode("303132333435363738393a3b3c3d3e3f").unwrap();
        let blob = B64.decode("0NHS09TV1tfY2drbJZ0ce3RCG0i0EICWCdYTm+EKZSq1kMXRsm4f2W7/J5HmeggSeYBPvPZDwcdrxdlC4OHi4+Tl5ufo6err1Pq/S+A+mPL+qpiD6IU1DO5AifyjF5bd423NXg7+hwnaeobRBLlt+OwggGrhnqflbxJl896ipHaoQrJxDjkDuwVML20R8+mx9Yilb0xDTQ9dLixLda6R3ZWP+5/NEUCf0JxwHplJHjaAACwnqgkM+LNfzFsJVjXaOaAvNd7nbJmu4fjz4UA9OG6gffNKKmWuxehRnyJTyEcbRMMGDPWl6UujJ/fWMfVxpSQYV7v8bXHTxvoIR0rKjcv+").unwrap();
        let pt = open_item(&kek, "device", "alice", &id, 1_700_000_000_000, &blob).expect("decrypts");
        assert!(String::from_utf8(pt).unwrap().contains("\"name\":\"Fairphone\""));
        assert!(open_item(&kek, "location", "alice", &id, 1_700_000_000_000, &blob).is_none());
        assert!(open_item(&kek, "device", "bob", &id, 1_700_000_000_000, &blob).is_none());
        assert!(open_item(&kek, "device", "alice", &id, 1_700_000_000_001, &blob).is_none());
    }

    /// Against the QuitFind TEST server; run through tests/desktop_sync.mjs (sets the env vars).
    #[test]
    #[ignore]
    fn sync_against_test_server() {
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} not set"));
        let (server, owner, pwk, phone) = (env("QF_TEST_SERVER"), env("QF_TEST_OWNER"), env("QF_TEST_PWK64"), env("QF_TEST_PHONE"));
        assert!(!server.contains(":8090") && !server.contains(":8443"), "never the real server");
        let mut refused = HashSet::new();
        let devs = sync(&server, &owner, &pwk, &mut refused).expect("sync");
        assert_eq!(devs.len(), 3);
        let p = devs.iter().find(|d| d.name == "Fairphone").expect("phone");
        assert_eq!((p.kind.as_str(), p.fixes.len(), p.fixes[1].bat), ("phone", 2, Some(80)));
        let t = devs.iter().find(|d| d.kind == "tag").expect("tag");
        assert_eq!(t.fixes[0].seen_by.as_deref(), Some(phone.as_str()));
        let bad = devs.iter().find(|d| d.name == "Oud").expect("stale device");
        assert!(bad.error.is_some() && refused.contains(&bad.username), "refused key is remembered");
        // a second round does not try the refused key again
        let again = sync(&server, &owner, &pwk, &mut refused).expect("sync 2");
        assert!(again.iter().find(|d| d.name == "Oud").unwrap().error.as_deref().unwrap().contains("refused"));
    }

    #[test]
    fn malformed_fixes_are_skipped() {
        assert!(parse_fix(br#"{"lat":"x","lon":4,"date":1}"#).is_none());
        assert!(parse_fix(br#"{"lat":95,"lon":4,"date":1}"#).is_none());
        let f = parse_fix(br#"{"lat":52.1,"lon":5.1,"date":1700000000000,"bat":-1,"provider":"ble","seenBy":"qf-phone"}"#).unwrap();
        assert_eq!((f.t, f.bat, f.seen_by.as_deref()), (1_700_000_000, None, Some("qf-phone")));
    }
}
