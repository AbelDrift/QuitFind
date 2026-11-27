//! Open Find: a Google-free device finder for Linux desktops.
//! Bluetooth tags, beacons and Apple/Android devices are found by this computer's Bluetooth;
//! phones and laptops report their own location over the local network.
mod bt;
mod core;
mod fmd;
mod server;

use crate::core::Core;
use eframe::egui::{
    self, Align, Align2, Color32, CornerRadius, FontId, Frame, Layout, Margin, RichText, Sense,
    Stroke, Vec2, pos2, vec2,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkers::{HttpOptions, HttpTiles, MapMemory, Position, lat_lon, sources::OpenStreetMap};

const ACCENT: Color32 = Color32::from_rgb(26, 115, 232);
const LOST: Color32 = Color32::from_rgb(217, 48, 37);
const GREY: Color32 = Color32::from_rgb(95, 99, 104);

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Tag,
    Beacon,
    Phone,
    Tablet,
    Laptop,
    Computer,
    Watch,
    Headphones,
    Other,
}

impl Kind {
    const ALL: [Kind; 9] = [
        Kind::Tag,
        Kind::Beacon,
        Kind::Phone,
        Kind::Tablet,
        Kind::Laptop,
        Kind::Computer,
        Kind::Watch,
        Kind::Headphones,
        Kind::Other,
    ];
    fn icon(self) -> &'static str {
        match self {
            Kind::Tag => "🏷",
            Kind::Beacon => "📡",
            Kind::Phone => "📱",
            Kind::Tablet => "📖",
            Kind::Laptop => "💻",
            Kind::Computer => "🖥",
            Kind::Watch => "⌚",
            Kind::Headphones => "🎧",
            Kind::Other => "🔵",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Kind::Tag => "Tracker tag",
            Kind::Beacon => "Beacon",
            Kind::Phone => "Phone",
            Kind::Tablet => "Tablet",
            Kind::Laptop => "Laptop",
            Kind::Computer => "Computer",
            Kind::Watch => "Watch",
            Kind::Headphones => "Headphones",
            Kind::Other => "Other device",
        }
    }
    fn color(self) -> Color32 {
        match self {
            Kind::Tag => Color32::from_rgb(242, 153, 0),
            Kind::Beacon => Color32::from_rgb(161, 66, 244),
            Kind::Phone | Kind::Tablet => ACCENT,
            Kind::Laptop | Kind::Computer => Color32::from_rgb(24, 128, 56),
            Kind::Watch | Kind::Headphones => Color32::from_rgb(0, 137, 123),
            Kind::Other => GREY,
        }
    }
    pub fn from_word(w: &str) -> Option<Kind> {
        let w = w.to_lowercase();
        Kind::ALL.into_iter().find(|k| {
            let l = k.label().to_lowercase();
            l == w || l.split(' ').next() == Some(w.as_str()) || format!("{k:?}").to_lowercase() == w
        })
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct Fix {
    lat: f64,
    lon: f64,
    t: u64,
    acc: f32,
    via: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Device {
    id: String,
    name: String,
    kind: Kind,
    #[serde(default)]
    what: String,
    #[serde(default)]
    lost: bool,
    #[serde(default)]
    seen: Option<u64>,
    #[serde(default)]
    last: Option<Fix>,
    #[serde(default)]
    history: Vec<Fix>,
    #[serde(default)]
    battery: Option<u8>,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    devices: Vec<Device>,
    computer: Option<(f64, f64)>,
    key: String,
    #[serde(default)]
    quitfind: Option<fmd::QfConfig>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn ago(t: u64) -> String {
    let s = now().saturating_sub(t);
    match s {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", s / 60),
        3600..=86399 => format!("{} h ago", s / 3600),
        _ => format!("{} days ago", s / 86400),
    }
}

fn metres(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, la2) = (a.0.to_radians(), b.0.to_radians());
    let (dla, dlo) = (la2 - la1, (b.1 - a.1).to_radians());
    let h = (dla / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlo / 2.0).sin().powi(2);
    12_742_000.0 * h.sqrt().asin()
}

// The folder keeps its old name "open-find": existing devices of the earlier Open Find app stay where they are
fn store_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"));
    base.join("open-find").join("devices.json")
}

fn cache_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".cache"));
    base.join("open-find").join("tiles")
}

fn random_key() -> String {
    use std::hash::{BuildHasher, Hasher};
    let h = |salt: u64| {
        let mut x = std::hash::RandomState::new().build_hasher();
        x.write_u64(salt ^ now());
        x.finish()
    };
    format!("{:08x}{:08x}", h(1) as u32, h(std::process::id() as u64) as u32)
}

fn lan_ip() -> String {
    // UDP "connect" picks the outgoing interface without sending anything.
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("10.255.255.255:9").and(s.local_addr()))
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "this-computer".into())
}

fn notify(text: &str) {
    let _ = std::process::Command::new("notify-send").args(["QuitFind", text]).spawn();
}

#[derive(PartialEq, Clone, Copy)]
enum Tab {
    Mine,
    Nearby,
    Connect,
}

struct App {
    core: Core,
    tiles: HttpTiles,
    map: MapMemory,
    tab: Tab,
    selected: Option<String>,
    placing: bool,
    confirm_remove: bool,
    lan_ip: String,
    shot: Option<(PathBuf, u32)>,
    qf_server: String,
    qf_user: String,
    qf_password: String,
}

impl App {
    fn new(cc: &eframe::CreationContext, shot: Option<PathBuf>) -> Self {
        let ctx = cc.egui_ctx.clone();
        style(&ctx);
        let wake_ctx = ctx.clone();
        let core = Core::new(Arc::new(move || wake_ctx.request_repaint()));
        let options = HttpOptions {
            cache: Some(cache_dir()),
            user_agent: Some(walkers::HeaderValue::from_static("QuitFind-Desktop/0.1 (Linux)")),
            ..Default::default()
        };
        let mut map = MapMemory::default();
        let _ = map.set_zoom(if core.store.computer.is_some() { 15.0 } else { 7.0 });
        App {
            tiles: HttpTiles::with_options(OpenStreetMap, options, ctx),
            map,
            core,
            tab: Tab::Mine,
            selected: None,
            placing: false,
            confirm_remove: false,
            lan_ip: lan_ip(),
            shot: shot.map(|p| (p, 0)),
            qf_server: String::new(),
            qf_user: String::new(),
            qf_password: String::new(),
        }
    }

    // ---------- side panel ----------

    fn side(&mut self, ui: &mut egui::Ui) {
        if let Some(id) = self.selected.clone() {
            if self.core.store.devices.iter().any(|d| d.id == id) {
                return self.details(ui, &id);
            }
            self.selected = None;
        }
        ui.horizontal(|ui| {
            for (tab, label) in [
                (Tab::Mine, format!("My devices ({})", self.core.store.devices.len())),
                (Tab::Nearby, format!("Nearby ({})", self.core.nearby.len())),
                (Tab::Connect, "Connect a phone".to_string()),
            ] {
                let on = self.tab == tab;
                let text = RichText::new(label).color(if on { Color32::WHITE } else { GREY });
                let b = egui::Button::new(text)
                    .fill(if on { ACCENT } else { Color32::from_gray(238) })
                    .corner_radius(CornerRadius::same(16));
                if ui.add(b).clicked() {
                    self.tab = tab;
                }
            }
        });
        ui.add_space(8.0);
        egui::ScrollArea::vertical().auto_shrink(false).show(ui, |ui| match self.tab {
            Tab::Mine => self.my_devices(ui),
            Tab::Nearby => self.nearby_list(ui),
            Tab::Connect => self.connect(ui),
        });
    }

    fn my_devices(&mut self, ui: &mut egui::Ui) {
        if self.core.store.devices.is_empty() {
            card(ui, |ui| {
                ui.label(RichText::new("No devices yet").strong().size(17.0));
                ui.label("Add a Bluetooth tag, beacon or nearby device from the Nearby tab, or connect a phone or laptop so it can send in its location.");
                ui.horizontal(|ui| {
                    if ui.button("🔍 See what's nearby").clicked() {
                        self.tab = Tab::Nearby;
                    }
                    if ui.button("📱 Connect a phone").clicked() {
                        self.tab = Tab::Connect;
                    }
                });
            });
        }
        let mut open = None;
        for d in &self.core.store.devices {
            let (status, live) = self.core.status_line(d);
            let r = click_card(ui, |ui| {
                ui.horizontal(|ui| {
                    badge(ui, d.kind, d.lost, 40.0);
                    ui.vertical(|ui| {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(&d.name).strong().size(16.0));
                            if d.lost {
                                ui.label(RichText::new("LOST").color(LOST).strong().size(11.0));
                            }
                        });
                        let col = if live { Color32::from_rgb(30, 142, 62) } else { GREY };
                        ui.label(RichText::new(status).color(col).size(13.0));
                        if let Some(b) = d.battery {
                            ui.label(RichText::new(format!("🔋 {b}%")).color(GREY).size(12.0));
                        }
                    });
                });
            });
            if r.clicked() {
                open = Some(d.id.clone());
            }
        }
        if let Some(id) = open {
            self.open(&id);
        }
        ui.add_space(12.0);
        self.computer_card(ui);
    }

    fn open(&mut self, id: &str) {
        self.selected = Some(id.to_string());
        self.confirm_remove = false;
        if let Some(f) = self.core.store.devices.iter().find(|d| d.id == id).and_then(|d| d.last.as_ref()) {
            self.map.center_at(lat_lon(f.lat, f.lon));
            if self.map.zoom() < 14.0 {
                let _ = self.map.set_zoom(16.0);
            }
        }
    }

    fn computer_card(&mut self, ui: &mut egui::Ui) {
        card(ui, |ui| {
            ui.horizontal(|ui| {
                badge(ui, Kind::Computer, false, 32.0);
                ui.vertical(|ui| {
                    ui.label(RichText::new("This computer").strong());
                    let text = match self.core.store.computer {
                        Some((la, lo)) => format!("Placed at {la:.5}, {lo:.5}"),
                        None => "Location not set. Bluetooth finds are placed here.".into(),
                    };
                    ui.label(RichText::new(text).color(GREY).size(12.0));
                });
            });
            ui.horizontal(|ui| {
                let label = if self.placing { "Click on the map…" } else { "📍 Set on map" };
                if ui.selectable_label(self.placing, label).clicked() {
                    self.placing = !self.placing;
                }
                if let Some((la, lo)) = self.core.store.computer {
                    if ui.button("Show").clicked() {
                        self.map.center_at(lat_lon(la, lo));
                    }
                }
            });
        });
    }

    fn nearby_list(&mut self, ui: &mut egui::Ui) {
        ui.label(RichText::new(&self.core.bt_status).color(GREY).size(13.0));
        ui.label(
            RichText::new("Tip: many tags hide by changing their Bluetooth address every few minutes. Add them while they're right next to you and not yet set up with a phone, or use a simple key-finder tag.")
                .color(GREY)
                .size(12.0),
        );
        ui.add_space(6.0);
        let mut add = None;
        for (i, s) in self.core.nearby.iter().enumerate() {
            let id = format!("bt:{}", s.address);
            let added = self.core.store.devices.iter().any(|d| d.id == id);
            card(ui, |ui| {
                ui.horizontal(|ui| {
                    badge(ui, s.kind, false, 34.0);
                    ui.vertical(|ui| {
                        ui.set_max_width(ui.available_width() - 70.0);
                        let name = if s.name.is_empty() { s.what } else { &s.name };
                        ui.label(RichText::new(name).strong());
                        ui.label(RichText::new(s.what).color(GREY).size(12.0));
                        ui.horizontal(|ui| {
                            signal(ui, s.rssi);
                            let d = bt::distance_m(s.rssi, s.tx_power);
                            ui.label(RichText::new(format!("~{d:.1} m · {}", s.address)).color(GREY).size(11.0));
                        });
                    });
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if added {
                            ui.label(RichText::new("✔ Added").color(GREY));
                        } else if ui.button("+ Add").clicked() {
                            add = Some(i);
                        }
                    });
                });
            });
        }
        if self.core.nearby.is_empty() {
            ui.label("Nothing found yet. Make sure Bluetooth is on and the device is close by.");
        }
        if let Some(i) = add {
            let address = self.core.nearby[i].address.clone();
            self.core.add_nearby(&address);
        }
    }

    fn connect(&mut self, ui: &mut egui::Ui) {
        self.quitfind_card(ui);
        let url = format!("http://{}:{}/report?key={}", self.lan_ip, server::PORT, self.core.store.key);
        let web = format!("http://{}:{}/#key={}", self.lan_ip, server::PORT, self.core.store.key);
        card(ui, |ui| {
            ui.label(RichText::new("🌐 Open in a browser").strong().size(16.0));
            ui.label("The same map and devices, on any phone or computer in your network:");
            ui.horizontal(|ui| {
                ui.hyperlink_to(&web, &web);
                if ui.small_button("Copy").clicked() {
                    ui.ctx().copy_text(web.clone());
                }
            });
        });
        card(ui, |ui| {
            ui.label(RichText::new("Phones, tablets and laptops").strong().size(16.0));
            ui.label("They send their own location to this computer over your network. No Google account needed.");
            ui.add_space(4.0);
            ui.label(RichText::new("Your private address").strong());
            ui.horizontal(|ui| {
                ui.code(&url);
                if ui.small_button("Copy").clicked() {
                    ui.ctx().copy_text(url.clone());
                    self.core.say("Address copied");
                }
            });
            ui.label(RichText::new(&self.core.server_status).color(GREY).size(12.0));
        });
        card(ui, |ui| {
            ui.label(RichText::new("📱 Android or iPhone").strong());
            ui.label("1. Install the free OwnTracks app.\n2. In its settings choose Mode: HTTP.\n3. Paste the address above as the URL and give the phone a Device ID.\nThe phone shows up here by itself.");
            ui.add_space(4.0);
            ui.label(RichText::new("Or with GPSLogger (Android), custom URL:").size(12.0));
            ui.code(format!("{url}&id=myphone&lat=%LAT&lon=%LON&acc=%ACC&batt=%BATT"));
        });
        card(ui, |ui| {
            ui.label(RichText::new("💻 Laptop or other computer").strong());
            ui.label("Send a location from any computer with one command (it works with scripts and schedulers):");
            ui.code(format!("curl \"{url}&id=laptop&name=My%20laptop&kind=laptop&lat=52.37&lon=4.89\""));
        });
        ui.label(
            RichText::new("Away from home, the device can only reach this computer through your own VPN or port forward. If a firewall is on, allow port 8765.")
                .color(GREY)
                .size(12.0),
        );
    }

    fn quitfind_card(&mut self, ui: &mut egui::Ui) {
        card(ui, |ui| {
            ui.label(RichText::new("🗺 QuitFind server").strong().size(16.0));
            if let Some(c) = self.core.store.quitfind.clone() {
                ui.label(format!("Linked as {} on {}", c.user, c.server));
                ui.label(RichText::new(&self.core.qf_status).color(GREY).size(12.0));
                if ui.button("Unlink").clicked() {
                    self.core.qf_unlink();
                }
                return;
            }
            ui.label("Show all devices of your QuitFind owner account on this map (create it on the QuitFind web page).");
            ui.add(egui::TextEdit::singleline(&mut self.qf_server).hint_text("Server, e.g. https://…"));
            ui.add(egui::TextEdit::singleline(&mut self.qf_user).hint_text("Owner account name"));
            ui.add(egui::TextEdit::singleline(&mut self.qf_password).password(true).hint_text("Password"));
            let ready = !self.core.qf_busy && !self.qf_server.trim().is_empty() && !self.qf_user.trim().is_empty() && !self.qf_password.is_empty();
            if ui.add_enabled(ready, egui::Button::new("Link")).clicked() {
                self.core.qf_link(self.qf_server.trim().into(), self.qf_user.trim().into(), std::mem::take(&mut self.qf_password));
            }
            if !self.core.qf_status.is_empty() {
                ui.label(RichText::new(&self.core.qf_status).color(GREY).size(12.0));
            }
        });
    }

    fn details(&mut self, ui: &mut egui::Ui, id: &str) {
        if ui.button("← All devices").clicked() {
            self.selected = None;
            return;
        }
        let Some(idx) = self.core.store.devices.iter().position(|d| d.id == id) else { return };
        let (status, live) = self.core.status_line(&self.core.store.devices[idx]);
        let near = self.core.nearby.iter().position(|s| id.strip_prefix("bt:") == Some(s.address.as_str()));
        let d = &mut self.core.store.devices[idx];
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            badge(ui, d.kind, d.lost, 56.0);
            ui.vertical(|ui| {
                if ui.add(egui::TextEdit::singleline(&mut d.name).font(FontId::proportional(20.0)).desired_width(220.0)).changed() {
                    self.core.dirty = true;
                }
                let color = if live { Color32::from_rgb(30, 142, 62) } else { GREY };
                ui.label(RichText::new(status).color(color));
            });
        });
        ui.add_space(4.0);
        egui::ComboBox::from_label("Type")
            .selected_text(format!("{} {}", d.kind.icon(), d.kind.label()))
            .show_ui(ui, |ui| {
                for k in Kind::ALL {
                    if ui.selectable_value(&mut d.kind, k, format!("{} {}", k.icon(), k.label())).changed() {
                        self.core.dirty = true;
                    }
                }
            });
        if !d.what.is_empty() {
            ui.label(RichText::new(&d.what).color(GREY).size(12.0));
        }
        if let Some(b) = d.battery {
            ui.label(format!("🔋 Battery {b}%"));
        }
        ui.add_space(8.0);

        let mut ring = None;
        ui.horizontal_wrapped(|ui| {
            if let Some(f) = &d.last {
                if ui.button("🎯 Show on map").clicked() {
                    self.map.center_at(lat_lon(f.lat, f.lon));
                }
                if ui.button("🗺 Directions").clicked() {
                    let url = format!("https://www.openstreetmap.org/directions?to={}%2C{}", f.lat, f.lon);
                    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
                }
            }
            if d.id.starts_with("bt:") {
                let b = ui.add_enabled(near.is_some(), egui::Button::new("🔔 Ring"));
                let b = b.on_disabled_hover_text("The device must be near this computer to ring it");
                if b.clicked() {
                    ring = near;
                }
            }
        });
        ui.add_space(6.0);
        let (label, fill) = if d.lost { ("✔ I found it", Color32::from_rgb(30, 142, 62)) } else { ("⚠ Mark as lost", LOST) };
        if ui.add(egui::Button::new(RichText::new(label).color(Color32::WHITE)).fill(fill)).clicked() {
            d.lost = !d.lost;
            self.core.found_notified.remove(&d.id);
            self.core.dirty = true;
        }
        if d.lost {
            ui.label(RichText::new("You'll get a desktop notification as soon as it is seen again.").color(LOST).size(12.0));
        }

        if let Some(i) = near {
            let s = &self.core.nearby[i];
            ui.add_space(10.0);
            card(ui, |ui| {
                ui.label(RichText::new("Find nearby").strong());
                let strength = ((s.rssi as f32 + 100.0) / 60.0).clamp(0.02, 1.0);
                let words = match strength {
                    x if x > 0.75 => "Very close",
                    x if x > 0.5 => "Getting warmer",
                    x if x > 0.25 => "In the area",
                    _ => "Far away",
                };
                ui.add(egui::ProgressBar::new(strength).fill(ACCENT).text(words));
                ui.label(
                    RichText::new(format!("About {:.1} m · move around and watch the bar", bt::distance_m(s.rssi, s.tx_power)))
                        .color(GREY)
                        .size(12.0),
                );
            });
        }

        let d = &self.core.store.devices[idx];
        if let Some(f) = &d.last {
            ui.add_space(10.0);
            card(ui, |ui| {
                ui.label(RichText::new("Last known location").strong());
                ui.label(format!("{:.5}, {:.5}  (±{:.0} m)", f.lat, f.lon, f.acc));
                ui.label(RichText::new(format!("{} · {}", f.via, ago(f.t))).color(GREY).size(12.0));
            });
        }
        if d.history.len() > 1 {
            ui.add_space(6.0);
            ui.collapsing(format!("Location history ({})", d.history.len()), |ui| {
                for f in d.history.iter().rev().take(30) {
                    ui.label(RichText::new(format!("{} — {:.4}, {:.4}", ago(f.t), f.lat, f.lon)).size(12.0));
                }
            });
        }
        ui.add_space(14.0);
        if !self.confirm_remove {
            if ui.button("🗑 Remove device").clicked() {
                self.confirm_remove = true;
            }
        } else {
            ui.horizontal(|ui| {
                ui.label("Remove it and its history?");
                if ui.button(RichText::new("Remove").color(LOST)).clicked() {
                    self.core.store.devices.remove(idx);
                    self.selected = None;
                    self.core.dirty = true;
                }
                if ui.button("Keep").clicked() {
                    self.confirm_remove = false;
                }
            });
        }
        if ring.is_some() {
            self.core.ring(id);
        }
    }

    // ---------- map ----------

    fn map_view(&mut self, ui: &mut egui::Ui) {
        let home = self.core.store.computer.map(|(a, o)| lat_lon(a, o)).unwrap_or(lat_lon(52.13, 5.29));
        let devices = &self.core.store.devices;
        let computer = self.core.store.computer;
        let selected = self.selected.clone();
        let placing = self.placing;
        let rect = ui.available_rect_before_wrap();
        let action = walkers::Map::new(Some(&mut self.tiles), &mut self.map, home)
            .show(ui, |ui, response, proj, _| {
                let p = ui.painter();
                let at = |lat: f64, lon: f64| proj.project(lat_lon(lat, lon)).to_pos2();
                if let Some(sel) = devices.iter().find(|d| Some(&d.id) == selected.as_ref()) {
                    let pts: Vec<_> = sel.history.iter().map(|f| at(f.lat, f.lon)).collect();
                    p.add(egui::Shape::line(pts, Stroke::new(3.0, ACCENT.gamma_multiply(0.6))));
                }
                if let Some((la, lo)) = computer {
                    let c = at(la, lo);
                    p.circle_filled(c, 11.0, Color32::WHITE);
                    p.circle_filled(c, 8.0, ACCENT);
                    p.text(c + vec2(14.0, 0.0), Align2::LEFT_CENTER, "This computer", FontId::proportional(12.0), Color32::BLACK);
                }
                let mut hit = None;
                let pointer = response.interact_pointer_pos().or(response.hover_pos());
                for d in devices {
                    let Some(f) = &d.last else { continue };
                    let c = at(f.lat, f.lon);
                    let acc = f.acc * proj.scale_pixel_per_meter(lat_lon(f.lat, f.lon));
                    let col = if d.lost { LOST } else { d.kind.color() };
                    if acc > 20.0 {
                        p.circle(c, acc, col.gamma_multiply(0.12), Stroke::new(1.0, col.gamma_multiply(0.5)));
                    }
                    let big = Some(&d.id) == selected.as_ref();
                    let r = if big { 20.0 } else { 16.0 };
                    let tip = c - vec2(0.0, r + 8.0);
                    p.add(egui::Shape::convex_polygon(
                        vec![c, tip + vec2(-r * 0.6, r * 0.6), tip + vec2(r * 0.6, r * 0.6)],
                        col,
                        Stroke::NONE,
                    ));
                    p.circle(tip, r, col, Stroke::new(if big { 3.0 } else { 2.0 }, Color32::WHITE));
                    p.text(tip, Align2::CENTER_CENTER, d.kind.icon(), FontId::proportional(r), Color32::WHITE);
                    let label = p.text(c + vec2(0.0, 4.0), Align2::CENTER_TOP, &d.name, FontId::proportional(13.0), Color32::BLACK);
                    let _ = label;
                    if pointer.is_some_and(|q| q.distance(tip) < r + 2.0) {
                        hit = Some(d.id.clone());
                    }
                }
                if response.clicked() {
                    if let Some(id) = hit {
                        return Some(Err(id));
                    }
                    if placing {
                        if let Some(q) = response.interact_pointer_pos() {
                            let pos: Position = proj.unproject(q.to_vec2());
                            return Some(Ok((pos.y(), pos.x())));
                        }
                    }
                }
                None
            })
            .inner;
        match action {
            Some(Err(id)) => self.open(&id),
            Some(Ok(spot)) => {
                self.core.store.computer = Some(spot);
                self.placing = false;
                self.core.dirty = true;
                self.core.say("This computer's location is set");
            }
            None => {}
        }

        // Overlays: zoom buttons, attribution, hints.
        let ctx = ui.ctx().clone();
        egui::Area::new(egui::Id::unique("zoom"))
            .fixed_pos(rect.right_bottom() - vec2(56.0, 140.0))
            .show(&ctx, |ui| {
                Frame::new().fill(Color32::WHITE).corner_radius(CornerRadius::same(10)).inner_margin(Margin::same(4)).show(ui, |ui| {
                    let b = |t| egui::Button::new(RichText::new(t).size(20.0)).min_size(Vec2::splat(36.0)).frame(false);
                    if ui.add(b("+")).clicked() {
                        let _ = self.map.zoom_in();
                    }
                    if ui.add(b("−")).clicked() {
                        let _ = self.map.zoom_out();
                    }
                    if ui.add(b("⌖")).on_hover_text("Back to this computer").clicked() {
                        self.map.follow_my_position();
                    }
                });
            });
        egui::Area::new(egui::Id::unique("attrib"))
            .fixed_pos(rect.right_bottom() - vec2(190.0, 22.0))
            .show(&ctx, |ui| {
                Frame::new().fill(Color32::from_white_alpha(200)).inner_margin(Margin::symmetric(4, 1)).show(ui, |ui| {
                    ui.hyperlink_to(RichText::new("© OpenStreetMap contributors").size(11.0), "https://www.openstreetmap.org/copyright");
                });
            });
        let hint = if self.placing {
            Some("Click on the map where this computer is".to_string())
        } else {
            self.core.message.as_ref().filter(|(_, t)| t.elapsed() < Duration::from_secs(5)).map(|(m, _)| m.clone())
        };
        if let Some(h) = hint {
            egui::Area::new(egui::Id::unique("hint"))
                .anchor(Align2::CENTER_TOP, vec2(0.0, 0.0))
                .fixed_pos(pos2(rect.center().x, rect.top() + 14.0))
                .pivot(Align2::CENTER_TOP)
                .show(&ctx, |ui| {
                    Frame::new()
                        .fill(Color32::from_rgb(32, 33, 36))
                        .corner_radius(CornerRadius::same(18))
                        .inner_margin(Margin::symmetric(16, 8))
                        .show(ui, |ui| ui.label(RichText::new(h).color(Color32::WHITE)));
                });
        }
    }
}

fn card<R>(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui) -> R) -> egui::Response {
    let r = Frame::new()
        .fill(Color32::WHITE)
        .stroke(Stroke::new(1.0, Color32::from_gray(225)))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::same(12))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui)
        })
        .response;
    ui.add_space(6.0);
    r
}

/// A card that opens on click. Only for cards without buttons inside:
/// the click area lies on top and would swallow their clicks.
fn click_card<R>(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui) -> R) -> egui::Response {
    let r = card(ui, add);
    let r = ui.interact(r.rect, r.id.with("card"), Sense::click());
    if r.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    r
}

fn badge(ui: &mut egui::Ui, kind: Kind, lost: bool, size: f32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    let col = if lost { LOST } else { kind.color() };
    ui.painter().circle_filled(rect.center(), size / 2.0, col.gamma_multiply(0.15));
    ui.painter().text(rect.center(), Align2::CENTER_CENTER, kind.icon(), FontId::proportional(size * 0.5), col);
}

fn signal(ui: &mut egui::Ui, rssi: i16) {
    let (rect, _) = ui.allocate_exact_size(vec2(22.0, 12.0), Sense::hover());
    let bars = match rssi {
        r if r > -60 => 4,
        r if r > -70 => 3,
        r if r > -80 => 2,
        _ => 1,
    };
    for i in 0..4 {
        let h = 3.0 + i as f32 * 3.0;
        let x = rect.left() + i as f32 * 5.5;
        let bar = egui::Rect::from_min_max(pos2(x, rect.bottom() - h), pos2(x + 4.0, rect.bottom()));
        let col = if i < bars { ACCENT } else { Color32::from_gray(210) };
        ui.painter().rect_filled(bar, 1.0, col);
    }
}

fn style(ctx: &egui::Context) {
    ctx.set_visuals(egui::Visuals::light());
    ctx.all_styles_mut(|s| {
        use egui::TextStyle::*;
        s.text_styles.insert(Body, FontId::proportional(15.0));
        s.text_styles.insert(Button, FontId::proportional(15.0));
        s.text_styles.insert(Heading, FontId::proportional(22.0));
        s.text_styles.insert(Small, FontId::proportional(12.0));
        s.spacing.button_padding = vec2(10.0, 5.0);
        s.spacing.item_spacing = vec2(8.0, 6.0);
        s.visuals.panel_fill = Color32::from_rgb(246, 248, 252);
        s.visuals.widgets.inactive.corner_radius = CornerRadius::same(8);
        s.visuals.widgets.hovered.corner_radius = CornerRadius::same(8);
        s.visuals.widgets.active.corner_radius = CornerRadius::same(8);
        s.visuals.selection.bg_fill = ACCENT.gamma_multiply(0.25);
    });
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.core.poll();
        egui::Panel::top("top")
            .frame(Frame::new().fill(Color32::WHITE).inner_margin(Margin::symmetric(16, 10)))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("⌖").size(24.0).color(ACCENT));
                    ui.label(RichText::new("QuitFind").size(21.0).strong());
                    ui.label(RichText::new("your devices, no Google account").color(GREY).size(13.0));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let lost = self.core.store.devices.iter().filter(|d| d.lost).count();
                        if lost > 0 {
                            ui.label(RichText::new(format!("⚠ {lost} lost")).color(LOST).strong());
                        }
                        let ok = self.core.bt_status.starts_with("Scanning");
                        let col = if ok { Color32::from_rgb(30, 142, 62) } else { LOST };
                        ui.label(RichText::new(format!("📶 {}", if ok { "Bluetooth on" } else { &self.core.bt_status })).color(col).size(13.0));
                    });
                });
            });
        egui::Panel::left("side")
            .exact_size(380.0)
            .frame(Frame::new().fill(Color32::from_rgb(246, 248, 252)).inner_margin(Margin::same(14)))
            .show(ui, |ui| self.side(ui));
        egui::CentralPanel::no_frame().show(ui, |ui| self.map_view(ui));

        // Live "here now" status fades without new events, so keep ticking.
        ui.ctx().request_repaint_after(Duration::from_secs(1));
        if let Some((path, frames)) = &mut self.shot {
            *frames += 1;
            ui.ctx().request_repaint();
            if *frames == 120 {
                let path = path.clone();
                ui.ctx().request_screenshot(move |img| {
                    let raw: Vec<u8> = img.pixels.iter().flat_map(|c| c.to_array()).collect();
                    let ok = image::RgbaImage::from_raw(img.size[0] as u32, img.size[1] as u32, raw)
                        .map(|i| i.save(&path).is_ok())
                        .unwrap_or(false);
                    std::process::exit(if ok { 0 } else { 1 });
                });
            }
        }
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        if self.core.dirty {
            self.core.save();
        }
    }
}

fn main() -> eframe::Result {
    let args: Vec<String> = std::env::args().collect();
    let shot = args.iter().position(|a| a == "--screenshot").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    if args.iter().any(|a| a == "--server") {
        // No window: Bluetooth, phone reports and the web page only (for a home server).
        let mut core = Core::new(Arc::new(|| {}));
        println!("QuitFind is running. Open http://{}:{}/#key={} in a browser.", lan_ip(), server::PORT, core.store.key);
        loop {
            core.poll();
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    let mut viewport = egui::ViewportBuilder::default()
        .with_title("QuitFind")
        .with_app_id("open-find")
        .with_inner_size([1280.0, 800.0])
        .with_min_inner_size([900.0, 560.0]);
    if shot.is_some() {
        viewport = viewport.with_active(false);
    }
    let options = eframe::NativeOptions { viewport, ..Default::default() };
    eframe::run_native("QuitFind", options, Box::new(|cc| Ok(Box::new(App::new(cc, shot)))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buttons_inside_cards_get_clicks() {
        let ctx = egui::Context::default();
        let (mut at, mut clicked) = (pos2(0.0, 0.0), false);
        let pointer = |p: egui::Pos2, pressed: bool| egui::Event::PointerButton {
            pos: p,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: Default::default(),
        };
        for frame in 0..4 {
            let mut input = egui::RawInput::default();
            if frame == 1 {
                input.events = vec![egui::Event::PointerMoved(at), pointer(at, true)];
            } else if frame == 2 {
                input.events = vec![pointer(at, false)];
            }
            let mut out = ctx.run_ui(input, |ui| {
                card(ui, |ui| {
                    let b = ui.button("Set on map");
                    at = b.rect.center();
                    clicked |= b.clicked();
                });
            });
            out.textures_delta.clear();
        }
        assert!(clicked);
    }
}
