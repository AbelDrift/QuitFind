// QuitFind owner dashboard: one map with the latest location of every device, plus the
// history track of the selected device.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type * as LeafletType from 'leaflet';
import { FullScreen } from 'leaflet.fullscreen';
import { Laptop, Monitor, Smartphone, Tablet, Tag, type LucideIcon } from 'lucide-react';

import type { Location } from '@/lib/api';
import { apiService } from '@/lib/apiService';
import { DEVICE_TYPES, type DeviceEntry, type DeviceType } from '@/lib/owner';
import { useStore } from '@/lib/store';
import { useThemeColors } from '@/hooks/useThemeColors';
import { esc, locationPopup } from '@/components/LocationMap';

import 'leaflet/dist/leaflet.css';

export const TYPE_ICONS: Record<DeviceType, LucideIcon> = {
  phone: Smartphone,
  tablet: Tablet,
  laptop: Laptop,
  pc: Monitor,
  tag: Tag,
};

const POPUP = { autoClose: false, closeOnClick: false, closeButton: false };

interface DevicesMapProps {
  markers: { device: DeviceEntry; loc: Location }[]; // latest location per device
  track: Location[]; // selected device, oldest first
  selected: string | null;
  onSelect: (username: string) => void;
  nameOf: (username: string) => string;
}

interface MapParts {
  L: typeof LeafletType;
  map: LeafletType.Map;
  layer: LeafletType.LayerGroup;
}

export const DevicesMap = ({ markers, track, selected, onSelect, nameOf }: DevicesMapProps) => {
  const { t } = useTranslation('dashboard');
  const units = useStore((s) => s.units);
  const { mapPrimaryColor } = useThemeColors();

  const mapRef = useRef<HTMLDivElement>(null);
  const iconsRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef('');
  const [parts, setParts] = useState<MapParts | null>(null);

  // The basic map view, as in LocationMap
  useEffect(() => {
    let map: LeafletType.Map | null = null;
    let observer: ResizeObserver | null = null;
    let cancelled = false;

    void (async () => {
      const [L, tileServerUrl] = await Promise.all([
        import('leaflet').then((m) => m.default),
        apiService()
          .getTileServerUrl()
          .catch(() => 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
      ]);
      if (cancelled || !mapRef.current) return;

      map = L.map(mapRef.current).setView([20, 0], 2);
      L.tileLayer(tileServerUrl, {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
        referrerPolicy: 'strict-origin-when-cross-origin',
      }).addTo(map);
      map.attributionControl?.setPrefix('');
      map.addControl(new FullScreen());
      setParts({ L, map, layer: L.layerGroup().addTo(map) });
      observer = new ResizeObserver(() => map?.invalidateSize());
      observer.observe(mapRef.current);
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      map?.remove();
    };
  }, []);

  // Markers and track
  useEffect(() => {
    if (!parts) return;
    const { L, layer } = parts;
    layer.clearLayers();

    const popup = (loc: Location, title = '') =>
      title +
      locationPopup(
        loc,
        t,
        units,
        loc.seenBy ? `${esc(t('owner.seen_by', { name: nameOf(loc.seenBy) }))}<br/>` : ''
      );
    const hover = (l: LeafletType.Marker | LeafletType.CircleMarker) =>
      l.on('mouseover', () => l.openPopup()).on('mouseout', () => l.closePopup());

    if (track.length > 1) {
      L.polyline(
        track.map((loc): [number, number] => [loc.lat, loc.lon]),
        { color: mapPrimaryColor, weight: 3, opacity: 0.6 }
      ).addTo(layer);
    }
    for (const loc of track) {
      hover(
        L.circleMarker([loc.lat, loc.lon], {
          radius: 4,
          color: mapPrimaryColor,
          weight: 1,
          fillOpacity: 0.8,
        })
          .bindPopup(popup(loc), POPUP)
          .addTo(layer)
      );
    }

    for (const { device, loc } of markers) {
      const isSelected = device.username === selected;

      // A copy of the type icon that React rendered below, and the name (textContent: no HTML).
      // A tag lies where the device that saw it was: its name goes below the pin, not over that one.
      const el = document.createElement('div');
      el.className = `flex w-max gap-1 ${device.type === 'tag' ? 'flex-col items-start' : 'items-center'}`;
      const pin = el.appendChild(document.createElement('span'));
      pin.className = `grid size-7 place-items-center rounded-full border-2 border-white text-white shadow ${
        isSelected ? 'bg-fmd-map-accent' : 'bg-fmd-green'
      }`;
      const icon = iconsRef.current?.querySelector(`[data-type="${device.type}"]`);
      if (icon) pin.append(icon.cloneNode(true));
      const label = el.appendChild(document.createElement('span'));
      label.className = 'rounded bg-white/90 px-1 text-xs font-semibold text-gray-900 shadow';
      label.textContent = device.name;

      const marker = L.marker([loc.lat, loc.lon], {
        icon: L.divIcon({ html: el, className: '', iconSize: [28, 28], iconAnchor: [14, 14] }),
        title: device.name,
        zIndexOffset: isSelected ? 1000 : device.type === 'tag' ? -100 : 0,
      })
        .bindPopup(popup(loc, `<strong>${esc(device.name)}</strong><br/>`), POPUP)
        .on('click', () => onSelect(device.username))
        .addTo(layer);
      hover(marker);
    }
  }, [parts, markers, track, selected, onSelect, nameOf, units, mapPrimaryColor, t]);

  // Zoom to all devices, or to the track of the selected device (again when its length changes)
  useEffect(() => {
    if (!parts) return;
    const own = markers.filter((m) => m.device.username === selected).map((m) => m.loc);
    const points = selected ? (track.length ? track : own) : markers.map((m) => m.loc);
    const key = selected ? `${selected}:${track.length}` : `*:${markers.length}`;
    if (!points.length || fittedRef.current === key) return;

    fittedRef.current = key;
    parts.map.fitBounds(
      points.map((loc): [number, number] => [loc.lat, loc.lon]),
      { padding: [40, 40], maxZoom: 16 }
    );
  }, [parts, markers, track, selected]);

  return (
    <div className="bg-fmd-light dark:bg-fmd-dark relative flex h-full w-full flex-col rounded-lg">
      <div ref={mapRef} id="devices-map" className="relative flex-1 rounded-lg" />

      {/* Templates for the marker icons */}
      <div ref={iconsRef} hidden>
        {DEVICE_TYPES.map((type) => {
          const Icon = TYPE_ICONS[type];
          return <Icon key={type} data-type={type} className="size-4" />;
        })}
      </div>
    </div>
  );
};
