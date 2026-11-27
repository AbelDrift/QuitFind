import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  GOOGLE_BRIDGE,
  registerSettings,
  setGoogleBridge,
  useOwner,
  type GoogleBridge,
} from '@/lib/owner';

// QuitFind: optional Google bridge for Find Hub tags (owner account only)
export const GoogleBridgeSetting = () => {
  const { t } = useTranslation('dashboard');
  const items = useOwner((s) => s.items);
  const mode = registerSettings(items)?.googleBridge ?? 'off';
  const [busy, setBusy] = useState(false);

  const change = async (next: GoogleBridge) => {
    setBusy(true);
    try {
      await setGoogleBridge(next);
      toast.success(t('bridge.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="text-fmd-green mb-3 font-semibold">{t('bridge.title')}</h3>
      <p className="mb-2 text-sm">{t('bridge.explain')}</p>
      <NativeSelect
        aria-label={t('bridge.title')}
        value={mode}
        disabled={busy}
        onChange={(e) => void change(e.target.value as GoogleBridge)}
      >
        {GOOGLE_BRIDGE.map((m) => (
          <NativeSelectOption key={m} value={m}>
            {t(`bridge.${m}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {mode !== 'off' && <p className="mt-2 text-sm">{t(`bridge.hint_${mode}`)}</p>}
    </div>
  );
};
