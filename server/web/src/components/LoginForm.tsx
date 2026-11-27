import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { ApiError, getVersion } from '@/lib/api';
import { apiService } from '@/lib/apiService';
import { hashPasswordForLogin, PasswordHashResult } from '@/lib/crypto';
import { hashPasswordInWorker } from '@/lib/hashWorker';
import { createOwnerAccount } from '@/lib/owner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/PasswordInput';
import { Checkbox } from '@/components/Checkbox';
import { WebCryptoWarningModal } from './modals/WebCryptoWarningModal';
import { LanguageNativeSelect } from './LanguageNativeSelect';
import { ApiV2Service } from '@/lib/apiv2';
import { useStore } from '@/lib/store';

const SLOW_LOGIN_THRESHOLD_MS = 10_000;
const SLOW_LOGIN_TOAST_DURATION_MS = 30_000;

export const LoginForm = () => {
  const { t } = useTranslation(['login', 'errors']);

  const [fmdId, setFmdId] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState('');
  // QuitFind: 'register' creates a new owner account (device register, dashboard)
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [password2, setPassword2] = useState('');
  const [registrationToken, setRegistrationToken] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const ver = await getVersion();
        setVersion(ver);
      } catch {
        // Failed to fetch version, ignore
      }
    })();
  }, []);

  // QuitFind: create an owner account and log in to it
  const handleRegister = async () => {
    if (password !== password2) {
      toast.error(t('register.password_mismatch'));
      return;
    }
    setLoading(true);
    try {
      await createOwnerAccount(fmdId, password, registrationToken.trim(), rememberMe);
    } catch (error) {
      if (error instanceof ApiError && error.status == 401) {
        toast.error(t('register.bad_token'));
      } else {
        toast.error(error instanceof Error ? error.message : t('register.failed'));
      }
    } finally {
      setLoading(false);
    }
  };

  // Send the login request
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const [salt64, protoVersion] = await new ApiV2Service().getSalt(fmdId);
      await useStore.setState({ protoVersion: protoVersion });

      if (!salt64) {
        toast.error(t('errors:account_not_found'));
        setLoading(false);
        return;
      }

      // When JavaScript JIT is disabled (Jitless mode), password hashing is very slow (>= 2 mins)
      // https://gitlab.com/fmd-foss/fmd-server/-/issues/142
      const timeOut = setTimeout(() => {
        const msg = t(`login_slow`);
        toast.warning(msg, { duration: SLOW_LOGIN_TOAST_DURATION_MS });
      }, SLOW_LOGIN_THRESHOLD_MS);

      let passwordHash: PasswordHashResult;
      if (window.Worker) {
        // We need to launch the hashing in a background thread.
        // Otherwise, the timeout won't run, since the UI thread is blocked by the hashing.
        passwordHash = await hashPasswordInWorker(protoVersion, fmdId, password, salt64);
      } else {
        // Browser does not support Web Workers
        toast.warning(
          'Web Workers are not supported by this browser. Hashing password on main thread.'
        );
        passwordHash = await hashPasswordForLogin(protoVersion, fmdId, password, salt64);
      }

      clearTimeout(timeOut);

      await apiService().login(fmdId, password, passwordHash, rememberMe);
    } catch (error) {
      if (error instanceof ApiError && error.status == 404) {
        toast.error(t('errors:account_not_found'));
      } else {
        toast.error(error instanceof Error ? error.message : t('errors:login_failed'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col px-4">
      <div className="flex justify-end pt-8">
        <LanguageNativeSelect />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center py-8">
        <div className="dark:border-fmd-dark-border dark:bg-fmd-dark w-full max-w-md rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="text-fmd-green mb-6 text-center text-2xl font-bold">FMD Server</h1>

          <p className="mb-2 text-center text-sm text-gray-700 dark:text-gray-300">
            {t('subtitle')}
          </p>
          <p className="mb-8 text-center text-sm text-gray-700 dark:text-gray-300">
            {t('setup_instruction_1')}{' '}
            <a
              href="https://f-droid.org/packages/de.nulide.findmydevice/"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fmd-green text-gray-600 transition-colors duration-200 dark:text-gray-400"
            >
              {t('setup_instruction_2')}
            </a>{' '}
            {t('setup_instruction_3')}
          </p>

          {/* https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (mode === 'login' ? handleSubmit(e) : handleRegister());
            }}
            className="space-y-6"
          >
            <Input
              type="text"
              value={fmdId}
              onChange={(e) => setFmdId(e.target.value)}
              placeholder={t('username_placeholder')}
              autoComplete="username"
              pattern={mode === 'register' ? '[\\-_a-zA-Z0-9]{1,64}' : undefined}
              title={mode === 'register' ? t('register.username_hint') : undefined}
              required
            />

            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('password_placeholder')}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /* geheimen-check: ok */
              required
            />

            {mode === 'register' && (
              <>
                <PasswordInput
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  placeholder={t('register.password_repeat')}
                  autoComplete="new-password"
                  required
                />
                <Input
                  id="registration-token"
                  value={registrationToken}
                  onChange={(e) => setRegistrationToken(e.target.value)}
                  placeholder={t('register.token_placeholder')}
                  autoComplete="off"
                />
                <p className="text-xs text-gray-600 dark:text-gray-400">{t('register.hint')}</p>
              </>
            )}

            <Checkbox
              id="rememberMe"
              label={t('remember_me')}
              checked={rememberMe}
              onCheckedChange={(checked) => setRememberMe(checked === true)}
            />

            <Button type="submit" disabled={loading} size="lg" className="w-full text-lg">
              {mode === 'register'
                ? loading
                  ? t('register.creating')
                  : t('register.create')
                : loading
                  ? t('logging_in')
                  : t('log_in')}
            </Button>
          </form>

          <Button
            id="toggle-register"
            type="button"
            variant="link"
            className="mt-4 w-full"
            disabled={loading}
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? t('register.switch') : t('register.back')}
          </Button>

          <WebCryptoWarningModal />
        </div>
      </div>

      <footer className="pb-4 text-center text-sm text-gray-600 dark:text-gray-400">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <a
            href="https://fmd-foss.org"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fmd-green text-gray-600 transition-colors duration-200 dark:text-gray-400"
          >
            {t('project_website')}
          </a>
          <span>·</span>
          <a
            href="https://gitlab.com/fmd-foss/fmd-server/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fmd-green text-gray-600 transition-colors duration-200 dark:text-gray-400"
          >
            {t('source_code')}
          </a>
          <span>·</span>
          <Link
            to="/privacy"
            className="hover:text-fmd-green text-gray-600 transition-colors duration-200 dark:text-gray-400"
          >
            {t('privacy_notice')}
          </Link>
        </div>

        <div className="mt-2 h-4">
          {version && (
            <a
              href="https://gitlab.com/fmd-foss/fmd-server/-/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fmd-green font-mono text-xs text-gray-600 transition-colors duration-200 dark:text-gray-400"
            >
              v{version}
            </a>
          )}
        </div>
      </footer>
    </div>
  );
};
