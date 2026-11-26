//! Tiny HTTP receiver for location reports from phones and laptops
//! (OwnTracks "HTTP" mode JSON, GPSLogger custom URL, or plain curl).
use crate::Kind;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const PORT: u16 = 8765;

#[derive(Debug, PartialEq)]
pub struct Report {
    pub id: String,
    pub name: Option<String>,
    pub kind: Option<Kind>,
    pub lat: f64,
    pub lon: f64,
    pub acc: f32,
    pub battery: Option<u8>,
}

pub enum In {
    Report(Report),
    Error(String),
    Cmd(Cmd),
}

#[derive(Debug, PartialEq)]
pub enum Cmd {
    Add(String),
    Ring(String),
    Lost(String, bool),
    Remove(String),
    Place(f64, f64),
}

const PAGE: &str = include_str!("web.html");

pub fn spawn(key: String, tx: Sender<In>, web: Arc<Mutex<String>>, wake: crate::core::Wake) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("0.0.0.0", PORT)) {
            Ok(l) => l,
            Err(e) => {
                let _ = tx.send(In::Error(format!("Receiver and web page could not start: {e}")));
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            if let Some(msg) = handle(stream, &key, &web) {
                if tx.send(msg).is_err() {
                    return;
                }
                wake();
            }
        }
    });
}

fn handle(mut s: TcpStream, key: &str, web: &Mutex<String>) -> Option<In> {
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    // Read headers, then the body up to Content-Length; cap everything at 64 KB.
    let (head_end, len) = loop {
        let n = s.read(&mut chunk).ok().filter(|&n| n > 0)?;
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 65536 {
            return None;
        }
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
            let len = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0)
                .min(65536);
            break (i + 4, len);
        }
    };
    while buf.len() < head_end + len {
        let n = s.read(&mut chunk).ok().filter(|&n| n > 0)?;
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let body = String::from_utf8_lossy(&buf[head_end..head_end + len]).to_string();
    let (status, ctype, text, msg) = route(&head, &body, key, web);
    let _ = write!(
        s,
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    msg
}

type Reply = (&'static str, &'static str, String, Option<In>);

/// Web page, its data and commands, or a location report from a device.
fn route(head: &str, body: &str, key: &str, web: &Mutex<String>) -> Reply {
    const JSON: &str = "application/json";
    let target = head.lines().next().and_then(|l| l.split(' ').nth(1)).unwrap_or("");
    let (path, qs) = target.split_once('?').unwrap_or((target, ""));
    match path {
        "/" | "/index.html" => ("200 OK", "text/html; charset=utf-8", PAGE.to_string(), None),
        "/api/state" | "/api/cmd" => {
            let q = query(qs);
            if q.get("key").map(String::as_str) != Some(key) {
                return ("401 Unauthorized", JSON, r#"{"error":"key"}"#.into(), None);
            }
            if path == "/api/state" {
                return ("200 OK", JSON, web.lock().map(|w| w.clone()).unwrap_or_default(), None);
            }
            match command(&q) {
                Some(c) => ("200 OK", JSON, "{}".into(), Some(In::Cmd(c))),
                None => ("400 Bad Request", JSON, r#"{"error":"command"}"#.into(), None),
            }
        }
        _ => match parse(head, body, key) {
            Ok(r) => ("200 OK", JSON, "[]".into(), Some(In::Report(r))),
            Err(Bad::Ignored) => ("200 OK", JSON, "[]".into(), None),
            Err(Bad::Key) => ("401 Unauthorized", JSON, "wrong or missing key".into(), None),
            Err(Bad::Data) => ("400 Bad Request", JSON, "need id, lat and lon".into(), None),
        },
    }
}

fn command(q: &HashMap<String, String>) -> Option<Cmd> {
    let id = || q.get("id").filter(|v| !v.is_empty() && v.len() <= 80).cloned();
    let num = |k: &str| q.get(k).and_then(|v| v.parse::<f64>().ok());
    Some(match q.get("do")?.as_str() {
        "add" => Cmd::Add(id()?),
        "ring" => Cmd::Ring(id()?),
        "lost" => Cmd::Lost(id()?, q.get("on").map(String::as_str) == Some("1")),
        "remove" => Cmd::Remove(id()?),
        "place" => {
            let (lat, lon) = (num("lat")?, num("lon")?);
            if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
                return None;
            }
            Cmd::Place(lat, lon)
        }
        _ => return None,
    })
}

#[derive(Debug, PartialEq)]
pub enum Bad {
    Key,
    Data,
    Ignored,
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                Some(v) => {
                    out.push(v);
                    i += 2;
                }
                None => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query(s: &str) -> HashMap<String, String> {
    s.split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (decode(k).to_lowercase(), decode(v)))
        .collect()
}

pub fn parse(head: &str, body: &str, key: &str) -> Result<Report, Bad> {
    let target = head.lines().next().and_then(|l| l.split(' ').nth(1)).unwrap_or("");
    let mut q = query(target.split_once('?').map(|(_, q)| q).unwrap_or(""));
    if q.get("key").map(String::as_str) != Some(key) {
        return Err(Bad::Key);
    }
    let header = |name: &str| {
        head.lines()
            .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)))
            .map(|(_, v)| v.trim().to_string())
    };
    let num = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_f64());
    let (lat, lon, acc, batt);
    if let Ok(j) = serde_json::from_str::<serde_json::Value>(body) {
        if j["_type"] != "location" {
            return Err(Bad::Ignored);
        }
        (lat, lon, acc, batt) = (num(j.get("lat")), num(j.get("lon")), num(j.get("acc")), num(j.get("batt")));
        let tid = j["tid"].as_str().map(str::to_string);
        if !q.contains_key("id") {
            if let Some(d) = header("X-Limit-D").or(tid) {
                q.insert("id".into(), d);
            }
        }
    } else {
        q.extend(query(body.trim()));
        let f = |k: &str| q.get(k).and_then(|v| v.parse::<f64>().ok());
        (lat, lon, acc, batt) = (f("lat"), f("lon"), f("acc"), f("batt"));
    }
    let id = q.get("id").map(|s| s.trim().to_string()).unwrap_or_default();
    let (Some(lat), Some(lon)) = (lat, lon) else { return Err(Bad::Data) };
    if id.is_empty() || id.len() > 64 || !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err(Bad::Data);
    }
    Ok(Report {
        name: q.get("name").filter(|n| !n.is_empty()).map(|n| n.chars().take(64).collect()),
        kind: q.get("kind").and_then(|k| Kind::from_word(k)),
        id,
        lat,
        lon,
        acc: acc.unwrap_or(25.0).clamp(1.0, 100_000.0) as f32,
        battery: batt.map(|b| b.clamp(0.0, 100.0) as u8),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owntracks_json() {
        let head = "POST /report?key=abc HTTP/1.1\r\nX-Limit-D: pixel\r\n";
        let body = r#"{"_type":"location","lat":52.37,"lon":4.89,"acc":12,"batt":81,"tid":"px"}"#;
        let r = parse(head, body, "abc").unwrap();
        assert_eq!((r.id.as_str(), r.battery, r.acc), ("pixel", Some(81), 12.0));
    }

    #[test]
    fn url_report_and_checks() {
        let ok = "GET /report?key=abc&id=laptop&name=My%20laptop&kind=laptop&lat=52.1&lon=5.1 HTTP/1.1\r\n";
        let r = parse(ok, "", "abc").unwrap();
        assert_eq!(r.name.as_deref(), Some("My laptop"));
        assert_eq!(r.kind, Some(Kind::Laptop));
        assert_eq!(parse(ok, "", "other"), Err(Bad::Key));
        let far = "GET /report?key=abc&id=x&lat=95&lon=5 HTTP/1.1\r\n";
        assert_eq!(parse(far, "", "abc"), Err(Bad::Data));
        let status = "POST /report?key=abc HTTP/1.1\r\n";
        assert_eq!(parse(status, r#"{"_type":"status"}"#, "abc"), Err(Bad::Ignored));
    }

    #[test]
    fn web_routes() {
        let web = Mutex::new("{\"devices\":[]}".to_string());
        let r = |t: &str| route(&format!("GET {t} HTTP/1.1\r\n"), "", "abc", &web);
        assert!(r("/").2.contains("<html"));
        assert_eq!(r("/api/state?key=nope").0, "401 Unauthorized");
        assert_eq!(r("/api/state?key=abc").2, "{\"devices\":[]}");
        match r("/api/cmd?key=abc&do=lost&id=bt%3AAA&on=1").3 {
            Some(In::Cmd(c)) => assert_eq!(c, Cmd::Lost("bt:AA".into(), true)),
            _ => panic!("no command"),
        }
        assert_eq!(r("/api/cmd?key=abc&do=place&lat=99&lon=1").0, "400 Bad Request");
        assert!(matches!(r("/report?key=abc&id=p&lat=1&lon=2").3, Some(In::Report(_))));
    }
}
