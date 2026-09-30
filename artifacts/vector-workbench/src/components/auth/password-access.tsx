import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { ArrowLeft, CheckCircle2, CircleAlert, KeyRound, Loader2 } from 'lucide-react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="mesh-bg flex min-h-[100dvh] items-center justify-center bg-background p-5">
      <section className="w-full max-w-md rounded-2xl border border-card-border bg-card p-8 shadow-lg sm:p-10" aria-labelledby="password-access-title">
        <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-[hsl(var(--accent)/.18)] text-[hsl(var(--accent-foreground))]">
          <KeyRound size={22} />
        </div>
        <p className="mono mb-3 text-[10px] uppercase tracking-[.22em] text-muted-foreground">private workspace access</p>
        <h1 id="password-access-title" className="text-2xl font-extrabold tracking-[-.04em]">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
        <div className="mt-7">{children}</div>
      </section>
    </main>
  );
}

function getAppRedirectUrl() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

export function PasswordRecoveryRequest({
  client,
  initialEmail = '',
  onBack,
}: {
  client: SupabaseClient;
  initialEmail?: string;
  onBack: () => void;
}) {
  const form = useForm<{ email: string }>({ defaultValues: { email: initialEmail } });
  const [requestError, setRequestError] = useState('');
  const [sent, setSent] = useState(false);

  const requestReset = async ({ email }: { email: string }) => {
    setRequestError('');
    try {
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: getAppRedirectUrl(),
      });
      if (error) {
        setRequestError(error.message);
        return;
      }
      setSent(true);
    } catch {
      setRequestError('We could not send the reset email. Please try again.');
    }
  };

  return (
    <AuthShell
      title={sent ? 'Check your email' : 'Reset your password'}
      description={sent
        ? 'If an account exists for that address, a password reset link is on its way.'
        : 'We’ll email you a secure link to choose a new password.'}
    >
      {sent ? (
        <div className="space-y-5">
          <div role="status" data-testid="status-password-reset-sent" className="flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" />
            <span>Open the email on this device. The link returns you to Studio to set a new password.</span>
          </div>
          <button type="button" data-testid="button-back-to-sign-in" onClick={onBack} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-input text-sm font-bold transition hover:bg-muted">
            <ArrowLeft size={16} /> Back to sign in
          </button>
        </div>
      ) : (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(requestReset)} className="space-y-5" noValidate>
            <FormField
              control={form.control}
              name="email"
              rules={{
                required: 'Enter your work email.',
                pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address.' },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs font-bold uppercase tracking-[.1em] text-muted-foreground">Work email</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      data-testid="input-recovery-email"
                      type="email"
                      autoComplete="email"
                      className="h-12 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {requestError && (
              <div role="alert" data-testid="status-recovery-error" className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs leading-5 text-destructive">
                <CircleAlert size={15} className="mt-0.5 shrink-0" />{requestError}
              </div>
            )}
            <button type="submit" data-testid="button-send-reset-link" disabled={form.formState.isSubmitting} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-extrabold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
              {form.formState.isSubmitting ? <Loader2 size={17} className="animate-spin" /> : <KeyRound size={16} />}
              {form.formState.isSubmitting ? 'Sending…' : 'Send reset link'}
            </button>
            <button type="button" data-testid="button-cancel-password-reset" onClick={onBack} className="inline-flex h-10 w-full items-center justify-center gap-2 text-sm font-semibold text-muted-foreground transition hover:text-foreground">
              <ArrowLeft size={15} /> Back to sign in
            </button>
            <p className="text-center text-[11px] leading-5 text-muted-foreground">
              Reset links return to this app. Its public URL must be allowed in Supabase Auth URL Configuration.
            </p>
          </form>
        </Form>
      )}
    </AuthShell>
  );
}

export function PasswordSetup({
  client,
  onComplete,
}: {
  client: SupabaseClient;
  onComplete: () => void;
}) {
  const form = useForm<{ password: string; confirmation: string }>({
    defaultValues: { password: '', confirmation: '' },
  });
  const [updateError, setUpdateError] = useState('');
  const [updated, setUpdated] = useState(false);

  const updatePassword = async ({ password }: { password: string; confirmation: string }) => {
    setUpdateError('');
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) {
        setUpdateError(error.message);
        return;
      }
      setUpdated(true);
    } catch {
      setUpdateError('We could not update your password. Request a new secure link and try again.');
    }
  };

  return (
    <AuthShell
      title={updated ? 'Password updated' : 'Choose a password'}
      description={updated
        ? 'Your password is ready. Continue to the private Studio workspace.'
        : 'Choose a password for future sign-ins. Use at least 8 characters.'}
    >
      {updated ? (
        <div className="space-y-5">
          <div role="status" data-testid="status-password-updated" className="flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" />
            <span>Your password has been saved.</span>
          </div>
          <button type="button" data-testid="button-continue-after-password" onClick={onComplete} className="flex h-12 w-full items-center justify-center rounded-lg bg-primary text-sm font-extrabold text-primary-foreground shadow-sm transition hover:opacity-90">
            Continue to Studio
          </button>
        </div>
      ) : (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(updatePassword)} className="space-y-5" noValidate>
            <FormField
              control={form.control}
              name="password"
              rules={{
                required: 'Enter a new password.',
                minLength: { value: 8, message: 'Use at least 8 characters.' },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs font-bold uppercase tracking-[.1em] text-muted-foreground">New password</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      data-testid="input-new-password"
                      type="password"
                      autoComplete="new-password"
                      className="h-12 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmation"
              rules={{
                required: 'Confirm your new password.',
                validate: (value) => value === form.getValues('password') || 'Passwords do not match.',
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs font-bold uppercase tracking-[.1em] text-muted-foreground">Confirm password</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      data-testid="input-confirm-password"
                      type="password"
                      autoComplete="new-password"
                      className="h-12 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {updateError && (
              <div role="alert" data-testid="status-password-update-error" className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs leading-5 text-destructive">
                <CircleAlert size={15} className="mt-0.5 shrink-0" />{updateError}
              </div>
            )}
            <button type="submit" data-testid="button-save-password" disabled={form.formState.isSubmitting} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-extrabold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
              {form.formState.isSubmitting ? <Loader2 size={17} className="animate-spin" /> : <KeyRound size={16} />}
              {form.formState.isSubmitting ? 'Saving…' : 'Save password'}
            </button>
          </form>
        </Form>
      )}
    </AuthShell>
  );
}

export function AuthLinkExpired({
  type,
  onBack,
}: {
  type: 'invite' | 'recovery';
  onBack: () => void;
}) {
  const isInvite = type === 'invite';
  return (
    <AuthShell
      title={isInvite ? 'Invite link unavailable' : 'Reset link unavailable'}
      description={isInvite
        ? 'This invite link may have expired or already been used. Ask your workspace administrator to send a fresh invite.'
        : 'This password reset link may have expired or already been used. Return to sign in and request another.'}
    >
      <div role="alert" data-testid="status-auth-link-unavailable" className="mb-5 flex gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm leading-6 text-muted-foreground">
        <CircleAlert size={18} className="mt-0.5 shrink-0 text-destructive" />
        <span>{isInvite ? 'For security, invite links can only be used once.' : 'For security, reset links can only be used once.'}</span>
      </div>
      <button type="button" data-testid="button-return-to-sign-in" onClick={onBack} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-extrabold text-primary-foreground shadow-sm transition hover:opacity-90">
        <ArrowLeft size={16} /> Return to sign in
      </button>
    </AuthShell>
  );
}