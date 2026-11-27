// QuitFind: the dashboard of an owner account (lib/owner.ts): all devices of the register on
// one map, a device list, the history and commands of the selected device, and managing devices.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Pencil, Plus, RefreshCw, Tag, Trash2 } from 'lucide-react';

import { ApiError, type Location } from '@/lib/api';
import {
  deviceApi,
  registerDevices,
  removeDevice,
  useOwner,
  type DeviceEntry,
  type Stored,
} from '@/lib/owner';
import { formatRelative } from '@/utils/date';
import { cn } from '@/utils/cn';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DeviceCommands } from '@/components/DevicePanel';
import { DevicesMap, TYPE_ICONS } from '@/components/DevicesMap';
import { formatProvider } from '@/components/LocationMap';
import { ConfirmModal } from '@/components/modals/ConfirmModal';
import { DeviceDialog, type DeviceDialogMode } from '@/components/modals/DeviceDialog';
import { PhotosModal } from '@/components/modals/PhotosModal';

const HOUR = 60 * 60 * 1000;
const RANGES = { day: 24 * HOUR, week: 7 * 24 * HOUR, all: Infinity };
type Range = keyof typeof RANGES;

const POLL_MS = 60 * 1000;
const POLL_AFTER_LOCATE_MS = 10 * 1000; // for two minutes after a locate command

export const OwnerDashboard = () => {
  const { t } = useTranslation(['dashboard', 'errors']);
  const items = useOwner((s) => s.items);
  const devices = useMemo(() => registerDevices(items), [items]);

  // Per device account: its locations (oldest first) and the error of the last fetch, if any
  const [locations, setLocations] = useState<Record<string, Location[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<Range>('day');
  const [dialog, setDialog] = useState<DeviceDialogMode | null>(null);
  const [toRemove, setToRemove] = useState<Stored<DeviceEntry> | null>(null);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [pushUrl, setPushUrl] = useState<string | null>(null);
  const [lastLocate, setLastLocate] = useState(0);

  const sel = devices.find((d) => d.username === selected);

  // Devices log in one after another (lib/owner.ts); fetching runs in parallel
  const refresh = () =>
    Promise.all(
      devices.map(async (d) => {
        let message = '';
        try {
          const items = await deviceApi(d).getLocations();
          const list = items.map((it) => it.item).sort((a, b) => a.date - b.date);
          setLocations((prev) => ({ ...prev, [d.username]: list }));
        } catch (error) {
          // keep the locations we have (a network hiccup should not empty the map)
          message =
            error instanceof ApiError && error.status === 403
              ? t('owner.key_rejected')
              : error instanceof Error
                ? error.message
                : String(error);
        }
        setErrors((prev) => ({ ...prev, [d.username]: message }));
      })
    );

  // At start and when the register changes; then poll while the tab is visible
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const fast = Date.now() - lastLocate < 2 * 60 * 1000;
      timer = setTimeout(
        () => {
          if (!document.hidden) void refresh();
          schedule();
        },
        fast ? POLL_AFTER_LOCATE_MS : POLL_MS
      );
    };
    schedule();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, lastLocate]);

  // A device without push URL gets no commands
  useEffect(() => {
    setPushUrl(null);
    if (!sel || sel.type === 'tag') return;
    let current = true;
    deviceApi(sel)
      .getPushUrl()
      .then((url) => current && setPushUrl(url))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [sel]);

  const latest = (d: DeviceEntry) => locations[d.username]?.at(-1);

  const markers = useMemo(
    () =>
      devices.flatMap((device) => {
        const loc = locations[device.username]?.at(-1);
        return loc ? [{ device, loc }] : [];
      }),
    [devices, locations]
  );

  const track = useMemo(() => {
    const list = sel ? locations[sel.username] : undefined;
    if (!list) return [];
    const from = Date.now() - RANGES[range];
    return list.filter((loc) => loc.date >= from);
  }, [sel, locations, range]);

  const nameOf = useCallback(
    (username: string) => devices.find((d) => d.username === username)?.name ?? username,
    [devices]
  );

  const remove = async (device: Stored<DeviceEntry>) => {
    try {
      await removeDevice(device);
      if (selected === device.username) setSelected(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors:delete_failed'));
    }
  };

  const details = (d: DeviceEntry, loc?: Location) => {
    const seen = loc
      ? formatRelative(loc.date)
      : errors[d.username] === undefined
        ? t('loading')
        : t('owner.never_seen');
    return [
      t(`owner.types.${d.type}`),
      seen,
      loc && loc.bat >= 0 ? `${loc.bat}%` : null,
      loc ? formatProvider(loc.provider) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };

  return (
    <div className="dark:bg-fmd-dark-lighter flex h-[calc(100vh-3.1rem)] flex-col bg-gray-50 text-gray-900 dark:text-white">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:overflow-hidden">
        <div className="order-2 flex w-full flex-col gap-4 lg:order-1 lg:w-100 lg:shrink-0 lg:overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setDialog('link')}>
              <Plus />
              {t('owner.add_device')}
            </Button>
            <Button variant="outline" onClick={() => setDialog('tag')}>
              <Tag />
              {t('owner.add_tag')}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="ms-auto"
              title={t('owner.refresh')}
              aria-label={t('owner.refresh')}
              onClick={() => void refresh()}
            >
              <RefreshCw />
            </Button>
          </div>

          {devices.length === 0 && (
            <div className="dark:border-fmd-dark-border dark:bg-fmd-dark rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500 dark:text-gray-400">
              <div className="font-medium text-gray-900 dark:text-white">{t('no_devices')}</div>
              {t('owner.empty_hint')}
            </div>
          )}

          <ul id="device-list" className="flex flex-col gap-2">
            {devices.map((d) => {
              const Icon = TYPE_ICONS[d.type];
              const loc = latest(d);
              const error = errors[d.username];
              return (
                <li key={d.username} data-device={d.username}>
                  <button
                    type="button"
                    aria-pressed={d.username === selected}
                    onClick={() => setSelected(d.username === selected ? null : d.username)}
                    className={cn(
                      'dark:border-fmd-dark-border dark:bg-fmd-dark flex w-full cursor-pointer items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 text-left hover:bg-gray-100 dark:hover:bg-white/8',
                      d.username === selected && 'border-fmd-green ring-fmd-green ring-1'
                    )}
                  >
                    <div className="bg-fmd-green/10 rounded-full p-2">
                      <Icon className="text-fmd-green h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{d.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {details(d, loc)}
                      </div>
                      {loc?.seenBy && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {t('owner.seen_by', { name: nameOf(loc.seenBy) })}
                        </div>
                      )}
                      {error && (
                        <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {sel && (
            <div className="dark:border-fmd-dark-border dark:bg-fmd-dark space-y-3 rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-center gap-2">
                <h2 className="flex-1 truncate font-semibold">{sel.name}</h2>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={t('owner.edit')}
                  aria-label={t('owner.edit')}
                  onClick={() => setDialog(sel)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={t('owner.remove')}
                  aria-label={t('owner.remove')}
                  onClick={() => setToRemove(sel)}
                >
                  <Trash2 />
                </Button>
              </div>

              <ToggleGroup
                type="single"
                variant="outline"
                value={range}
                onValueChange={(value) => value && setRange(value as Range)}
              >
                {(Object.keys(RANGES) as Range[]).map((r) => (
                  <ToggleGroupItem key={r} value={r}>
                    {t(`owner.range.${r}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {t('owner.track_points', { count: track.length })}
              </div>
            </div>
          )}

          {sel && sel.type !== 'tag' && (
            <div className="flex flex-col gap-4">
              {pushUrl === '' && (
                <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900/50 dark:bg-yellow-900/20">
                  <p className="text-sm text-yellow-800 dark:text-yellow-200">
                    {t('location.no_push_url')}
                  </p>
                </div>
              )}
              <DeviceCommands
                key={sel.username}
                api={deviceApi(sel)}
                onViewPhotos={() => setPhotosOpen(true)}
                onLocateCommand={() => setLastLocate(Date.now())}
              />
            </div>
          )}
        </div>

        <div className="order-1 min-h-96 flex-1 rounded-lg lg:order-2 lg:min-h-0">
          <DevicesMap
            markers={markers}
            track={track}
            selected={selected}
            onSelect={setSelected}
            nameOf={nameOf}
          />
        </div>
      </div>

      {dialog && <DeviceDialog mode={dialog} onClose={() => setDialog(null)} />}

      {sel && (
        <PhotosModal
          isOpen={photosOpen}
          onClose={() => setPhotosOpen(false)}
          api={deviceApi(sel)}
        />
      )}

      <ConfirmModal
        isOpen={toRemove !== null}
        onCancel={() => setToRemove(null)}
        onConfirm={() => {
          if (toRemove) void remove(toRemove);
          setToRemove(null);
        }}
        title={t('owner.remove_title', { name: toRemove?.name })}
        message={t(toRemove?.type === 'tag' ? 'owner.remove_tag_message' : 'owner.remove_message')}
        confirmText={t('owner.remove')}
      />
    </div>
  );
};
