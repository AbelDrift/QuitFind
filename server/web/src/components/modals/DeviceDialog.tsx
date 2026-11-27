// QuitFind owner dashboard: link an existing device account, add a tag, or edit a device
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import {
  addTag,
  DEVICE_TYPES,
  editDevice,
  linkDevice,
  registerSettings,
  TAG_KINDS,
  useOwner,
  type DeviceEntry,
  type DeviceType,
  type Stored,
} from '@/lib/owner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { PasswordInput } from '@/components/PasswordInput';

// 'link' = add an existing FMD account, 'tag' = new tag account, a device = edit it
export type DeviceDialogMode = 'link' | 'tag' | Stored<DeviceEntry>;

interface DeviceDialogProps {
  mode: DeviceDialogMode;
  onClose: () => void;
}

export const DeviceDialog = ({ mode, onClose }: DeviceDialogProps) => {
  const { t } = useTranslation(['dashboard', 'login', 'errors', 'common']);
  const edit = typeof mode === 'object' ? mode : null;

  const [form, setForm] = useState({
    username: '',
    password: '',
    name: edit?.name ?? '',
    type: edit?.type ?? 'phone',
    kind: TAG_KINDS[0] as string,
    id: '',
    token: '',
  });
  // the token is asked once (no settings item yet) or again when the stored one was rejected
  const [askToken, setAskToken] = useState(
    mode === 'tag' && !registerSettings(useOwner.getState().items)
  );
  const [busy, setBusy] = useState(false);

  const field =
    (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const name = form.name.trim();
    try {
      if (mode === 'link') {
        await linkDevice(form.username.trim(), form.password, name, form.type as DeviceType);
      } else if (mode === 'tag') {
        const tag = { kind: form.kind, id: form.id.trim() };
        await addTag(name, tag, askToken ? form.token.trim() : undefined);
      } else {
        await editDevice(mode, name, form.type as DeviceType);
      }
      onClose();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (mode === 'tag' && status === 401) setAskToken(true);
      toast.error(
        status === 401 && mode === 'tag'
          ? t('login:register.bad_token')
          : status === 403
            ? t('owner.wrong_password')
            : status === 404
              ? t('errors:account_not_found')
              : error instanceof Error
                ? error.message
                : String(error)
      );
    } finally {
      setBusy(false);
    }
  };

  const title = edit
    ? t('owner.edit')
    : mode === 'tag'
      ? t('owner.add_tag')
      : t('owner.add_device');
  const description = edit
    ? edit.username
    : mode === 'tag'
      ? t('owner.add_tag_description')
      : t('owner.add_device_description');

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form id="device-form" onSubmit={(e) => void submit(e)} className="space-y-4">
          {mode === 'link' && (
            <>
              <Input
                id="device-username"
                value={form.username}
                onChange={field('username')}
                placeholder={t('login:username_placeholder')}
                autoComplete="off"
                pattern="[\-_a-zA-Z0-9]{1,64}"
                required
              />
              <PasswordInput
                id="device-password"
                value={form.password}
                onChange={field('password')}
                placeholder={t('login:password_placeholder')}
                autoComplete="off"
                required
              />
            </>
          )}

          <Input
            id="device-name"
            value={form.name}
            onChange={field('name')}
            placeholder={t('owner.name')}
            maxLength={100}
            required
          />

          {mode === 'tag' && (
            <>
              <NativeSelect
                id="tag-kind"
                aria-label={t('owner.tag_kind')}
                value={form.kind}
                onChange={field('kind')}
              >
                {TAG_KINDS.map((kind) => (
                  <NativeSelectOption key={kind} value={kind}>
                    {t(`owner.tag_kinds.${kind}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Input
                id="tag-id"
                value={form.id}
                onChange={field('id')}
                placeholder={t('owner.tag_id')}
                autoComplete="off"
                required
              />
              {askToken && (
                <div>
                  <Input
                    id="tag-registration-token"
                    value={form.token}
                    onChange={field('token')}
                    placeholder={t('owner.registration_token')}
                    autoComplete="off"
                  />
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {t('owner.registration_token_hint')}
                  </p>
                </div>
              )}
            </>
          )}

          {mode !== 'tag' && edit?.type !== 'tag' && (
            <NativeSelect
              id="device-type"
              aria-label={t('owner.type')}
              value={form.type}
              onChange={field('type')}
            >
              {DEVICE_TYPES.filter((type) => type !== 'tag').map((type) => (
                <NativeSelectOption key={type} value={type}>
                  {t(`owner.types.${type}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}

          <DialogFooter className="gap-3 sm:gap-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('owner.busy') : t('common:confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
