//! The engine shared by the desktop window and the browser server:
//! saved devices, Bluetooth sightings, location reports and web commands.
use crate::bt::{self, BtMsg, Seen};
use crate::fmd::{self, QfConfig, RemoteDevice};
use crate::server::{self, Cmd, In};
use crate::{Device, Fix, Kind, Store, ago, metres, notify, now, random_key, store_path};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub type Wake = Arc<dyn Fn() + Send + Sync>;

pub enum QfCmd {
    Link { server: String, user: String, password: String },
    Unlink,
}

pub enum QfMsg {
    Linked(QfConfig),
    LinkFailed(String),
    Synced(Vec<RemoteDevice>),
    Failed(String),
}

/// QuitFind sync thread: every 60 s all devices of the linked owner account (see fmd.rs).
fn qf_spawn(mut cfg: Option<QfConfig>, rx: Receiver<QfCmd>, tx: Sender<QfMsg>, wake: Wake) {
    std::thread::spawn(move || {
        let mut refused = HashSet::new();
        let mut owner_refused = false; // never hammer a refused owner key (lockout after 7 misses)
        loop {
            if let (Some(c), false) = (&cfg, owner_refused) {
                let msg = match fmd::sync(&c.server, &c.user, &c.pwk64, &mut refused) {
                    Ok(d) => QfMsg::Synced(d),
                    Err(e) => {
                        owner_refused = matches!(e.status, 403 | 404 | 423);
                        QfMsg::Failed(e.text)
                    }
                };
                if tx.send(msg).is_err() {
                    break;
                }
                wake();
            }
            match rx.recv_timeout(Duration::from_secs(60)) {
                Ok(QfCmd::Link { server, user, password }) => {
                    let msg = match fmd::link(&server, &user, &password) {
                        Ok(pwk64) => {
                            let c = QfConfig { server, user, pwk64 };
                            cfg = Some(c.clone());
                            refused.clear();
                            owner_refused = false;
                            QfMsg::Linked(c)
                        }
                        Err(e) => QfMsg::LinkFailed(e.text),
                    };
                    let _ = tx.send(msg);
                    wake();
                }
                Ok(QfCmd::Unlink) => {
                    cfg = None;
                    refused.clear();
                    owner_refused = false;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}
const HERE_SECS: u64 = 30;

pub struct Core {
    pub store: Store,
    pub bt_tx: Sender<BtMsg>,
    bt_rx: Receiver<BtMsg>,
    in_rx: Receiver<In>,
    pub bt_status: String,
    pub server_status: String,
    pub nearby: Vec<Seen>,
    last_rssi: HashMap<String, i16>,
    pub found_notified: HashSet<String>,
    pub message: Option<(String, Instant)>,
    pub dirty: bool,
    last_save: Instant,
    web: Arc<Mutex<String>>,
    last_web: Instant,
    wake: Wake,
    qf_tx: Sender<QfCmd>,
    qf_rx: Receiver<QfMsg>,
    pub qf_status: String,
    pub qf_busy: bool,
}

impl Core {
    pub fn new(wake: Wake) -> Self {
        let mut store: Store = std::fs::read_to_string(store_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let dirty = store.key.is_empty();
        if dirty {
            store.key = random_key();
        }
        let (bt_tx, bt_rx) = channel();
        bt::spawn(bt_tx.clone(), wake.clone());
        let (in_tx, in_rx) = channel();
        let web = Arc::new(Mutex::new("{}".to_string()));
        server::spawn(store.key.clone(), in_tx, web.clone(), wake.clone());
        let (qf_tx, qf_cmd_rx) = channel();
        let (qf_msg_tx, qf_rx) = channel();
        qf_spawn(store.quitfind.clone(), qf_cmd_rx, qf_msg_tx, wake.clone());
        Core {
            store,
            bt_tx,
            bt_rx,
            in_rx,
            bt_status: "Starting Bluetooth…".into(),
            server_status: format!("Listening on port {} (phones, laptops and the web page)", server::PORT),
            nearby: Vec::new(),
            last_rssi: HashMap::new(),
            found_notified: HashSet::new(),
            message: None,
            dirty,
            last_save: Instant::now(),
            web,
            last_web: Instant::now() - Duration::from_secs(10),
            wake,
            qf_tx,
            qf_rx,
            qf_status: String::new(),
            qf_busy: false,
        }
    }

    pub fn qf_link(&mut self, server: String, user: String, password: String) {
        self.qf_busy = true;
        self.qf_status = "Logging in, this takes a few seconds…".into();
        let _ = self.qf_tx.send(QfCmd::Link { server, user, password });
    }

    pub fn qf_unlink(&mut self) {
        self.store.quitfind = None;
        self.store.devices.retain(|d| !d.id.starts_with("qf:"));
        self.qf_status.clear();
        self.dirty = true;
        let _ = self.qf_tx.send(QfCmd::Unlink);
    }

    /// Mirror the register: one local device "qf:<account>" per QuitFind device.
    fn qf_apply(&mut self, devs: Vec<RemoteDevice>) {
        let names: HashMap<String, String> = devs.iter().map(|d| (d.username.clone(), d.name.clone())).collect();
        let ids: HashSet<String> = devs.iter().map(|d| format!("qf:{}", d.username)).collect();
        self.store.devices.retain(|d| !d.id.starts_with("qf:") || ids.contains(&d.id));
        for d in devs {
            let id = format!("qf:{}", d.username);
            let kind = match d.kind.as_str() {
                "tag" => Kind::Tag,
                "tablet" => Kind::Tablet,
                "laptop" => Kind::Laptop,
                "pc" => Kind::Computer,
                _ => Kind::Phone,
            };
            let to_fix = |f: &fmd::RemoteFix| Fix {
                lat: f.lat,
                lon: f.lon,
                t: f.t,
                acc: f.acc,
                via: match &f.seen_by {
                    Some(s) => format!("QuitFind ({}), seen by {}", f.provider, names.get(s).unwrap_or(s)),
                    None => format!("QuitFind ({})", f.provider),
                },
            };
            if !self.store.devices.iter().any(|x| x.id == id) {
                self.store.devices.push(Device {
                    id: id.clone(), name: d.name.clone(), kind, what: String::new(), lost: false,
                    seen: None, last: None, history: Vec::new(), battery: None,
                });
            }
            let dev = self.store.devices.iter_mut().find(|x| x.id == id).expect("just added");
            dev.name = d.name.clone();
            dev.kind = kind;
            dev.what = d.error.clone().unwrap_or_else(|| "QuitFind".into());
            let start = d.fixes.len().saturating_sub(200);
            dev.history = d.fixes[start..].iter().map(to_fix).collect();
            dev.last = d.fixes.last().map(to_fix);
            dev.seen = d.fixes.last().map(|f| f.t);
            dev.battery = d.fixes.iter().rev().find_map(|f| f.bat);
        }
        self.dirty = true;
    }

    pub fn say(&mut self, text: impl Into<String>) {
        self.message = Some((text.into(), Instant::now()));
    }

    pub fn save(&mut self) {
        let path = store_path();
        let tmp = path.with_extension("json.tmp");
        let ok = path.parent().map(std::fs::create_dir_all).transpose().is_ok()
            && serde_json::to_vec_pretty(&self.store)
                .ok()
                .is_some_and(|d| std::fs::write(&tmp, d).is_ok())
            && restrict(&tmp)
            && std::fs::rename(&tmp, &path).is_ok();
        if !ok {
            self.say("Could not save your devices to disk");
        }
        self.dirty = false;
        self.last_save = Instant::now();
    }

    pub fn record(&mut self, id: &str, fix: Option<Fix>) {
        let Some(d) = self.store.devices.iter_mut().find(|d| d.id == id) else { return };
        d.seen = Some(now());
        if let Some(fix) = fix {
            let moved = d.history.last().is_none_or(|h| {
                metres((h.lat, h.lon), (fix.lat, fix.lon)) > 30.0 || fix.t.saturating_sub(h.t) > 600
            });
            if moved {
                d.history.push(fix.clone());
                if d.history.len() > 200 {
                    d.history.remove(0);
                }
            }
            d.last = Some(fix);
        }
        if d.lost && self.found_notified.insert(d.id.clone()) {
            notify(&format!("{} was found! Open the app to see where.", d.name));
        }
        self.dirty = true;
    }

    fn bt_fix(&self, s: &Seen) -> Option<Fix> {
        self.store.computer.map(|(lat, lon)| Fix {
            lat,
            lon,
            t: now(),
            acc: bt::distance_m(s.rssi, s.tx_power).max(5.0),
            via: "Near this computer (Bluetooth)".into(),
        })
    }

    /// Handle everything that arrived; call often (every frame or every second).
    pub fn poll(&mut self) {
        while let Ok(msg) = self.qf_rx.try_recv() {
            match msg {
                QfMsg::Linked(c) => {
                    self.qf_busy = false;
                    self.qf_status = "Linked. Loading your devices…".into();
                    self.store.quitfind = Some(c);
                    self.dirty = true;
                }
                QfMsg::LinkFailed(e) => {
                    self.qf_busy = false;
                    self.qf_status = format!("Could not link: {e}");
                }
                QfMsg::Synced(devs) => {
                    self.qf_status = format!("{} devices, updated {}", devs.len(), ago(now()));
                    self.qf_apply(devs);
                }
                QfMsg::Failed(e) => self.qf_status = format!("Sync failed: {e}"),
            }
        }
        while let Ok(msg) = self.bt_rx.try_recv() {
            match msg {
                BtMsg::Status(s) => self.bt_status = s,
                BtMsg::Ring(s) => self.say(s),
                BtMsg::Seen(seen) => {
                    for s in &seen {
                        let id = format!("bt:{}", s.address);
                        // shortcut: a device counts as seen when its signal reading changes; signal events would be exact.
                        let fresh = self.last_rssi.insert(s.address.clone(), s.rssi) != Some(s.rssi);
                        if fresh && self.store.devices.iter().any(|d| d.id == id) {
                            let fix = self.bt_fix(s);
                            self.record(&id, fix);
                        }
                    }
                    self.nearby = seen;
                    self.nearby.sort_by_key(|s| -s.rssi);
                }
            }
        }
        while let Ok(msg) = self.in_rx.try_recv() {
            match msg {
                In::Error(e) => self.server_status = e,
                In::Report(r) => {
                    let id = format!("rp:{}", r.id);
                    if !self.store.devices.iter().any(|d| d.id == id) {
                        self.store.devices.push(Device {
                            id: id.clone(),
                            name: r.name.clone().unwrap_or_else(|| r.id.clone()),
                            kind: r.kind.unwrap_or(Kind::Phone),
                            what: "Reports its own location".into(),
                            lost: false,
                            seen: None,
                            last: None,
                            history: Vec::new(),
                            battery: None,
                        });
                        self.say(format!("New device connected: {}", r.name.as_deref().unwrap_or(&r.id)));
                    }
                    if let Some(d) = self.store.devices.iter_mut().find(|d| d.id == id) {
                        d.battery = r.battery.or(d.battery);
                    }
                    let fix = Fix { lat: r.lat, lon: r.lon, t: now(), acc: r.acc, via: "Reported by the device".into() };
                    self.record(&id, Some(fix));
                }
                In::Cmd(c) => self.command(c),
            }
        }
        if self.dirty && self.last_save.elapsed() > Duration::from_secs(3) {
            self.save();
        }
        if self.last_web.elapsed() > Duration::from_secs(1) {
            let snap = self.snapshot();
            if let Ok(mut w) = self.web.lock() {
                *w = snap;
            }
            self.last_web = Instant::now();
        }
    }

    fn command(&mut self, c: Cmd) {
        match c {
            Cmd::Add(address) => self.add_nearby(&address),
            Cmd::Ring(id) => self.ring(&id),
            Cmd::Lost(id, on) => {
                if let Some(d) = self.store.devices.iter_mut().find(|d| d.id == id) {
                    d.lost = on;
                    self.found_notified.remove(&id);
                    self.dirty = true;
                }
            }
            Cmd::Remove(id) => {
                self.store.devices.retain(|d| d.id != id);
                self.dirty = true;
            }
            Cmd::Place(lat, lon) => {
                self.store.computer = Some((lat, lon));
                self.dirty = true;
            }
        }
        self.last_web = Instant::now() - Duration::from_secs(10);
    }

    pub fn add_nearby(&mut self, address: &str) {
        let id = format!("bt:{address}");
        let Some(s) = self.nearby.iter().find(|s| s.address == address) else { return };
        if self.store.devices.iter().any(|d| d.id == id) {
            return;
        }
        let name = if s.name.is_empty() { s.kind.label().to_string() } else { s.name.clone() };
        let fix = self.bt_fix(s);
        self.store.devices.push(Device {
            id: id.clone(),
            name: name.clone(),
            kind: s.kind,
            what: s.what.to_string(),
            lost: false,
            seen: None,
            last: None,
            history: Vec::new(),
            battery: None,
        });
        self.record(&id, fix);
        self.say(format!("{name} added to your devices"));
    }

    pub fn ring(&mut self, id: &str) {
        match self.nearby.iter().find(|s| id.strip_prefix("bt:") == Some(s.address.as_str())) {
            Some(s) => {
                bt::ring(s.path.clone(), self.bt_tx.clone(), self.wake.clone());
                self.say("Connecting to ring it…");
            }
            None => self.say("The device must be near this computer to ring it"),
        }
    }

    pub fn status_line(&self, d: &Device) -> (String, bool) {
        let here = d.seen.is_some_and(|t| now().saturating_sub(t) < HERE_SECS);
        if d.id.starts_with("bt:") && here {
            let dist = self
                .nearby
                .iter()
                .find(|s| d.id[3..] == s.address)
                .map(|s| format!(" · about {:.0} m away", bt::distance_m(s.rssi, s.tx_power).max(1.0)))
                .unwrap_or_default();
            return (format!("Near this computer{dist}"), true);
        }
        match (&d.last, d.seen) {
            (Some(f), _) if here => (format!("Live · updated {}", ago(f.t)), true),
            (Some(f), _) => (format!("Last seen {}", ago(f.t)), false),
            (None, Some(t)) => (format!("Seen {} · set this computer's location to map it", ago(t)), here),
            (None, None) => ("Not seen yet".into(), false),
        }
    }

    /// What the web page shows, as JSON.
    pub fn snapshot(&self) -> String {
        let devices: Vec<_> = self
            .store
            .devices
            .iter()
            .map(|d| {
                let (status, live) = self.status_line(d);
                json!({
                    "id": d.id, "name": d.name, "kind": d.kind, "label": d.kind.label(), "what": d.what,
                    "lost": d.lost, "battery": d.battery, "status": status, "live": live, "last": d.last,
                    "ago": d.last.as_ref().map(|f| ago(f.t)),
                    "near": self.nearby.iter().any(|s| d.id.strip_prefix("bt:") == Some(s.address.as_str())),
                    "history": d.history.iter().map(|f| [f.lat, f.lon]).collect::<Vec<_>>(),
                })
            })
            .collect();
        let nearby: Vec<_> = self
            .nearby
            .iter()
            .map(|s| {
                json!({
                    "address": s.address, "name": s.name, "what": s.what, "kind": s.kind, "rssi": s.rssi,
                    "dist": bt::distance_m(s.rssi, s.tx_power),
                    "added": self.store.devices.iter().any(|d| d.id == format!("bt:{}", s.address)),
                })
            })
            .collect();
        let message = self.message.as_ref().filter(|(_, t)| t.elapsed() < Duration::from_secs(6)).map(|(m, _)| m);
        json!({
            "devices": devices, "nearby": nearby, "computer": self.store.computer,
            "bt": self.bt_status, "message": message,
        })
        .to_string()
    }
}

/// The settings file holds keys: readable for this user only.
fn restrict(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).is_ok()
}
