//! The engine shared by the desktop window and the browser server:
//! saved devices, Bluetooth sightings, location reports and web commands.
use crate::bt::{self, BtMsg, Seen};
use crate::server::{self, Cmd, In};
use crate::{Device, Fix, Kind, Store, ago, metres, notify, now, random_key, store_path};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub type Wake = Arc<dyn Fn() + Send + Sync>;
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
        }
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
