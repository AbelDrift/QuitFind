//! Bluetooth through BlueZ on the system D-Bus: scan for nearby devices, and ring tags.
use crate::Kind;
use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::time::Duration;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

pub struct Seen {
    pub address: String,
    pub path: String,
    pub name: String,
    pub rssi: i16,
    pub tx_power: Option<i16>,
    pub kind: Kind,
    pub what: &'static str,
}

pub enum BtMsg {
    Status(String),
    Seen(Vec<Seen>),
    Ring(String),
}

type Objects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedValue>>>;

fn objects(conn: &Connection) -> zbus::Result<Objects> {
    Proxy::new(conn, "org.bluez", "/", "org.freedesktop.DBus.ObjectManager")?
        .call("GetManagedObjects", &())
}

/// Bytes from a D-Bus value, which BlueZ sometimes wraps in an extra variant.
fn unwrap<'a>(mut v: &'a Value<'a>) -> &'a Value<'a> {
    while let Value::Value(inner) = v {
        v = inner;
    }
    v
}

fn bytes(v: &Value) -> Vec<u8> {
    match unwrap(v) {
        Value::Array(a) => a.iter().filter_map(|b| if let Value::U8(b) = b { Some(*b) } else { None }).collect(),
        _ => Vec::new(),
    }
}

/// ManufacturerData (a{qv}) or ServiceData (a{sv}) as key -> bytes.
fn byte_map<K: Eq + std::hash::Hash>(
    props: &HashMap<String, OwnedValue>,
    key: &str,
    k: impl Fn(&Value) -> Option<K>,
) -> HashMap<K, Vec<u8>> {
    match props.get(key).map(|v| unwrap(v)) {
        Some(Value::Dict(d)) => d.iter().filter_map(|(kk, v)| Some((k(unwrap(kk))?, bytes(v)))).collect(),
        _ => HashMap::new(),
    }
}

fn prop<T: TryFrom<OwnedValue>>(props: &HashMap<String, OwnedValue>, key: &str) -> Option<T> {
    props
        .get(key)
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| T::try_from(v).ok())
}

/// Recognise what a device is from what it advertises.
pub fn classify(
    mfr: &HashMap<u16, Vec<u8>>,
    uuids: &[String],
    sdata: &HashMap<String, Vec<u8>>,
    icon: &str,
) -> (Kind, &'static str) {
    let has = |short: &str| {
        let p = format!("0000{short}");
        uuids.iter().any(|u| u.starts_with(&p)) || sdata.keys().any(|u| u.starts_with(&p))
    };
    if let Some((_, d)) = sdata.iter().find(|(u, _)| u.starts_with("0000feaa")) {
        return match d.first() {
            Some(0x40 | 0x41) => (Kind::Tag, "Find My Device network tag (Android tracker)"),
            _ => (Kind::Beacon, "Eddystone beacon"),
        };
    }
    if has("fd5a") {
        return (Kind::Tag, "Samsung SmartTag");
    }
    if has("feed") || has("feec") {
        return (Kind::Tag, "Tile tracker");
    }
    if has("fe2c") {
        return (Kind::Tag, "Fast Pair accessory (tag or earbuds in pairing mode)");
    }
    if let Some(d) = mfr.get(&0x004c) {
        return match d.as_slice() {
            [0x12, ..] => (Kind::Tag, "Apple Find My accessory (AirTag or similar)"),
            [0x02, 0x15, ..] => (Kind::Beacon, "iBeacon"),
            [0x07, ..] => (Kind::Headphones, "Apple AirPods / Beats"),
            _ => (Kind::Phone, "Apple device (iPhone, iPad, Mac or Watch)"),
        };
    }
    if mfr.values().any(|d| d.starts_with(&[0xbe, 0xac])) {
        return (Kind::Beacon, "AltBeacon");
    }
    if has("1802") || has("ffe0") {
        return (Kind::Tag, "Bluetooth key finder tag");
    }
    match icon {
        "phone" => return (Kind::Phone, "Phone"),
        "computer" => return (Kind::Laptop, "Computer"),
        i if i.starts_with("audio") => return (Kind::Headphones, "Audio device"),
        _ => {}
    }
    if mfr.contains_key(&0x0075) {
        return (Kind::Phone, "Samsung device");
    }
    if mfr.contains_key(&0x0006) {
        return (Kind::Computer, "Microsoft / Windows device");
    }
    (Kind::Other, "Bluetooth device")
}

/// Scan forever in a background thread; reconnects when Bluetooth comes back.
pub fn spawn(tx: Sender<BtMsg>, wake: crate::core::Wake) {
    std::thread::spawn(move || {
        loop {
            let msg = match scan(&tx, &wake) {
                Ok(m) => m,
                Err(e) => format!("Bluetooth not available ({e})"),
            };
            if tx.send(BtMsg::Status(msg)).is_err() {
                return;
            }
            wake();
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

fn scan(tx: &Sender<BtMsg>, wake: &crate::core::Wake) -> zbus::Result<String> {
    let conn = Connection::system()?;
    let Some(adapter) = objects(&conn)?
        .into_iter()
        .find(|(_, i)| i.contains_key("org.bluez.Adapter1"))
        .map(|(p, _)| p)
    else {
        return Ok("No Bluetooth adapter found".into());
    };
    let ad = Proxy::new(&conn, "org.bluez", adapter.as_str(), "org.bluez.Adapter1")?;
    let mut filter: HashMap<&str, Value> = HashMap::new();
    filter.insert("DuplicateData", true.into());
    let _: zbus::Result<()> = ad.call("SetDiscoveryFilter", &(filter,));
    loop {
        if !ad.get_property::<bool>("Powered")? {
            return Ok("Bluetooth is switched off".into());
        }
        if !ad.get_property::<bool>("Discovering")? {
            // Discovery belongs to this connection, so BlueZ stops it when the app closes.
            let _: zbus::Result<()> = ad.call("StartDiscovery", &());
        }
        let mut seen = Vec::new();
        for (path, ifaces) in objects(&conn)? {
            let Some(p) = ifaces.get("org.bluez.Device1") else { continue };
            let Some(rssi) = prop::<i16>(p, "RSSI") else { continue };
            let uuids: Vec<String> = prop(p, "UUIDs").unwrap_or_default();
            let icon: String = prop(p, "Icon").unwrap_or_default();
            let (kind, what) = classify(
                &byte_map(p, "ManufacturerData", |k| if let Value::U16(n) = k { Some(*n) } else { None }),
                &uuids,
                &byte_map(p, "ServiceData", |k| if let Value::Str(s) = k { Some(s.to_string()) } else { None }),
                &icon,
            );
            seen.push(Seen {
                address: prop(p, "Address").unwrap_or_default(),
                path: path.to_string(),
                name: prop::<String>(p, "Name").unwrap_or_default(),
                rssi,
                tx_power: prop(p, "TxPower"),
                kind,
                what,
            });
        }
        if tx.send(BtMsg::Status("Scanning for Bluetooth devices".into())).is_err()
            || tx.send(BtMsg::Seen(seen)).is_err()
        {
            return Ok(String::new());
        }
        wake();
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Make a tag beep through the standard Immediate Alert service (most cheap key finders).
pub fn ring(path: String, tx: Sender<BtMsg>, wake: crate::core::Wake) {
    std::thread::spawn(move || {
        let msg = match ring_now(&path) {
            Ok(()) => "The device is ringing".to_string(),
            Err(e) => format!("Could not ring it: {e}"),
        };
        let _ = tx.send(BtMsg::Ring(msg));
        wake();
    });
}

fn ring_now(path: &str) -> zbus::Result<()> {
    let conn = Connection::system()?;
    let dev = Proxy::new(&conn, "org.bluez", path, "org.bluez.Device1")?;
    dev.call::<_, _, ()>("Connect", &())?;
    for _ in 0..20 {
        if dev.get_property::<bool>("ServicesResolved").unwrap_or(false) {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let objs = objects(&conn)?;
    let service_uuid = |p: &str| {
        objs.iter()
            .find(|(op, _)| op.as_str() == p)
            .and_then(|(_, i)| i.get("org.bluez.GattService1"))
            .and_then(|s| prop::<String>(s, "UUID"))
            .unwrap_or_default()
    };
    let alert = objs.iter().find(|(op, i)| {
        op.as_str().starts_with(path)
            && i.get("org.bluez.GattCharacteristic1").is_some_and(|c| {
                prop::<String>(c, "UUID").is_some_and(|u| u.starts_with("00002a06"))
                    && prop::<OwnedObjectPath>(c, "Service")
                        .is_some_and(|s| service_uuid(s.as_str()).starts_with("00001802"))
            })
    });
    let Some((char_path, _)) = alert else {
        let _: zbus::Result<()> = dev.call("Disconnect", &());
        return Err(zbus::Error::Failure("this device has no ring function".into()));
    };
    let ch = Proxy::new(&conn, "org.bluez", char_path.as_str(), "org.bluez.GattCharacteristic1")?;
    let opts: HashMap<&str, Value> = HashMap::new();
    ch.call::<_, _, ()>("WriteValue", &(vec![2u8], opts.clone()))?;
    std::thread::sleep(Duration::from_secs(8));
    let _: zbus::Result<()> = ch.call("WriteValue", &(vec![0u8], opts));
    let _: zbus::Result<()> = dev.call("Disconnect", &());
    Ok(())
}

/// Rough distance in metres from signal strength (log-distance model, open space).
pub fn distance_m(rssi: i16, tx_power: Option<i16>) -> f32 {
    let at_1m = tx_power.map(|t| t - 41).unwrap_or(-59) as f32;
    10f32.powf((at_1m - rssi as f32) / 20.0).clamp(0.1, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_trackers() {
        let none = HashMap::new();
        let mut apple = HashMap::new();
        apple.insert(0x004c, vec![0x12, 0x19, 0x10]);
        assert_eq!(classify(&apple, &[], &none, "").0, Kind::Tag);
        apple.insert(0x004c, vec![0x02, 0x15, 0x00]);
        assert_eq!(classify(&apple, &[], &none, "").0, Kind::Beacon);
        let mut fmdn = HashMap::new();
        fmdn.insert("0000feaa-0000-1000-8000-00805f9b34fb".to_string(), vec![0x41, 1]);
        assert_eq!(classify(&HashMap::new(), &[], &fmdn, "").0, Kind::Tag);
        assert_eq!(classify(&HashMap::new(), &[], &none, "phone").0, Kind::Phone);
        assert_eq!(classify(&HashMap::new(), &[], &none, "").0, Kind::Other);
    }

    #[test]
    fn distance_grows_as_signal_drops() {
        assert!((distance_m(-59, None) - 1.0).abs() < 0.01);
        assert!(distance_m(-79, None) > 9.0);
    }
}
