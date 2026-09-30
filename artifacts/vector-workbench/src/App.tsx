import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createClient, type AuthChangeEvent, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { useForm } from 'react-hook-form';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CloudUpload,
  FileArchive,
  FileImage,
  FileOutput,
  KeyRound,
  Loader2,
  LogOut,
  PackageCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  getGetPublicConfigQueryKey,
  getGetVectorizerJobItemPngQueryKey,
  getGetVectorizerJobItemSvgQueryKey,
  getGetVectorizerJobQueryKey,
  getDownloadVectorizerJobQueryKey,
  setAuthTokenGetter,
  useCreateVectorizerJob,
  useDeleteVectorizerJob,
  useDownloadVectorizerJob,
  useGetPublicConfig,
  useGetVectorizerJobItemPng,
  useGetVectorizerJobItemSvg,
  useGetVectorizerJob,
  useProcessVectorizerJob,
  useRegenerateVectorizerJobItemName,
  useUpdateVectorizerJobItems,
  type VectorizerJob,
  type VectorizerJobItem,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { AuthLinkExpired, PasswordRecoveryRequest, PasswordSetup } from '@/components/auth/password-access';
import { LocalArchivePanel } from '@/components/local-archive-panel';
import { QuickConvertPanel, type QuickConvertOptions, type QuickConvertStage } from '@/components/quick-convert-panel';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import NotFound from '@/pages/not-found';
import {
  createSavedBatch,
  getSavedBatch,
  getSavedResultArchive,
  listSavedBatches,
  requestPersistentBrowserStorage,
  saveBatch,
  saveResultArchive,
  updateSavedBatch,
  type BatchProcessingOptions,
} from '@/lib/local-archive';

const queryClient = new QueryClient();

type DraftItem = Pick<VectorizerJobItem, 'id' | 'originalName' | 'suggestedName' | 'includeSvg' | 'status' | 'error' | 'pngReady' | 'svgReady'>;
type ImageSourceSummary = { png: number; jpeg: number };
const defaultBatchOptions: BatchProcessingOptions = {
  backgroundRemoval: true,
  seoNaming: true,
  svgOutput: true,
  preserveFolderStructure: true,
};
const defaultQuickOptions: QuickConvertOptions = {
  backgroundRemoval: true,
  seoNaming: true,
  svgOutput: true,
};

const statuses = ['analyzing', 'ready', 'processing', 'completed'] as const;
type WorkflowMode = 'quick' | 'batch';

function summarizeImageSources(items: Array<{ originalName: string; originalPath?: string }>): ImageSourceSummary {
  return items.reduce<ImageSourceSummary>((summary, item) => {
    const sourcePath = item.originalPath || item.originalName;
    if (/\.png$/i.test(sourcePath)) summary.png += 1;
    else if (/\.jpe?g$/i.test(sourcePath)) summary.jpeg += 1;
    return summary;
  }, { png: 0, jpeg: 0 });
}

function formatDurationRange(lowSeconds: number, highSeconds: number): string {
  if (highSeconds < 60) {
    const low = Math.max(5, Math.floor(lowSeconds / 5) * 5);
    const high = Math.max(low + 5, Math.ceil(highSeconds / 5) * 5);
    return `${low}–${high} sec`;
  }
  const lowMinutes = Math.max(1, Math.floor(lowSeconds / 60));
  const highMinutes = Math.max(lowMinutes + 1, Math.ceil(highSeconds / 60));
  return `${lowMinutes}–${highMinutes} min`;
}

function estimateConversionTime(
  imageCount: number,
  backgroundRemoval: boolean,
  svgCount: number,
  concurrency: number,
): string {
  const workers = Math.max(1, Math.min(imageCount, concurrency));
  const imageLow = backgroundRemoval ? 10 : 2;
  const imageHigh = backgroundRemoval ? 30 : 8;
  const svgLow = 3;
  const svgHigh = 12;
  const startupLow = backgroundRemoval ? 15 : 2;
  const startupHigh = backgroundRemoval ? 45 : 6;
  const low = startupLow + (imageCount * imageLow + svgCount * svgLow) / workers;
  const high = startupHigh + (imageCount * imageHigh + svgCount * svgHigh) / workers;
  return formatDurationRange(low, high);
}

function BatchSummary({
  job,
  estimate,
  estimateNote,
}: {
  job: VectorizerJob;
  estimate: string;
  estimateNote: string;
}) {
  const counts = summarizeImageSources(job.items);
  return (
    <section data-testid="batch-upload-summary" className="mb-5 grid gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:grid-cols-3 sm:items-center">
      <div>
        <p className="mono text-[9px] uppercase tracking-[.16em] text-muted-foreground">Images found</p>
        <p className="mt-1 text-sm font-extrabold text-foreground">{job.totalFiles} total</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{counts.png} PNG · {counts.jpeg} JPG/JPEG</p>
      </div>
      <div>
        <p className="mono text-[9px] uppercase tracking-[.16em] text-muted-foreground">{estimateNote}</p>
        <p className="mt-1 text-sm font-extrabold text-foreground">About {estimate}</p>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">Rough estimate; image complexity and server load can change the time.</p>
      </div>
      <div>
        <p className="mono text-[9px] uppercase tracking-[.16em] text-muted-foreground">Download folders</p>
        <p className="mt-1 text-sm font-extrabold text-foreground">{job.options.preserveFolderStructure ? 'Preserve ZIP folders' : 'Flat ZIP'}</p>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{job.options.preserveFolderStructure ? 'Outputs sit beside each source path.' : 'All outputs go in the ZIP root.'}</p>
      </div>
    </section>
  );
}

function createBlobObjectUrl(value: unknown): string | null {
  if (typeof Blob === 'undefined' || !(value instanceof Blob)) {
    const receivedType = value && typeof value === 'object'
      ? Object.prototype.toString.call(value)
      : typeof value;
    console.error(`Expected a Blob or File before creating an object URL; received ${receivedType}.`);
    return null;
  }
  try {
    return URL.createObjectURL(value);
  } catch (error) {
    console.error('Could not create an object URL for this image.', error);
    return null;
  }
}

function useObjectUrl(blob: unknown): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const nextUrl = createBlobObjectUrl(blob);
    if (!nextUrl) {
      setUrl(null);
      return;
    }
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);
  return url;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = createBlobObjectUrl(blob);
  if (!url) return;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BrandMark({ small = false, onClick }: { small?: boolean; onClick?: () => void }) {
  const content = (
    <span className={`flex items-center gap-3 ${small ? 'scale-90 origin-left' : ''}`}>
      <span className="relative flex size-9 items-center justify-center rounded-xl bg-[hsl(var(--sidebar-primary))] text-[hsl(var(--sidebar-primary-foreground))] shadow-sm">
        <span className="absolute h-4 w-4 rotate-45 rounded-[4px] border-2 border-current" />
        <span className="absolute h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      <span>
        <span className="block text-[15px] font-extrabold leading-none tracking-[-.04em]">vector batch</span>
        <span className="mt-1 block text-[10px] font-medium uppercase tracking-[.18em] text-sidebar-foreground/55">studio</span>
      </span>
    </span>
  );

  return onClick ? (
    <button
      type="button"
      aria-label="Go to workspace landing page"
      title="Workspace home"
      onClick={onClick}
      className="rounded-lg text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {content}
    </button>
  ) : (
    <div>{content}</div>
  );
}

function SetupState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <main className="mesh-bg flex min-h-[100dvh] items-center justify-center bg-background p-5">
      <section className="w-full max-w-md rounded-2xl border border-card-border bg-card p-8 text-center shadow-lg">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-[hsl(var(--accent)/.18)] text-[hsl(var(--accent-foreground))]">
          <KeyRound size={22} />
        </div>
        <p className="mono mb-3 text-[10px] uppercase tracking-[.22em] text-muted-foreground">workspace setup</p>
        <h1 className="text-2xl font-extrabold tracking-[-.04em]">Configuration needed</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{message}</p>
        <button data-testid="button-retry-config" onClick={retry} className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90">
          <RefreshCw size={15} /> Try again
        </button>
      </section>
    </main>
  );
}

type SignInValues = { email: string; password: string };
type PasswordFlow = 'invite' | 'recovery';
type WorkspaceUser = Pick<User, 'id' | 'email'>;
const passwordFlowStorageKey = 'vector-workbench-password-flow';
const developmentSessionStorageKey = 'vector-workbench-development-session';

function hasPersistedDevelopmentSession(): boolean {
  try {
    return window.localStorage.getItem(developmentSessionStorageKey) === 'active';
  } catch {
    return false;
  }
}

function persistDevelopmentSession(): void {
  try {
    window.localStorage.setItem(developmentSessionStorageKey, 'active');
  } catch {
    // The dev session remains usable for this tab if browser storage is unavailable.
  }
}

function clearPersistedDevelopmentSession(): void {
  try {
    window.localStorage.removeItem(developmentSessionStorageKey);
  } catch {
    // Nothing else is required if browser storage is unavailable.
  }
}

function getPersistedDevelopmentUser(email: string | null): WorkspaceUser | null {
  if (!import.meta.env.DEV || !email || !hasPersistedDevelopmentSession()) return null;
  return { id: `dev:${email}`, email };
}

function SignIn({
  client,
  onRecover,
  devLoginEmail,
  onDevLogin,
}: {
  client: SupabaseClient;
  onRecover: (email: string) => void;
  devLoginEmail: string | null;
  onDevLogin: () => void;
}) {
  const form = useForm<SignInValues>({ defaultValues: { email: '', password: '' } });
  const [error, setError] = useState('');

  const submit = form.handleSubmit(async ({ email, password }) => {
    setError('');
    try {
      const result = await client.auth.signInWithPassword({ email, password });
      if (result.error) setError(result.error.message);
    } catch {
      setError('We could not sign you in. Please try again.');
    }
  });

  return (
    <main className="mesh-bg relative flex min-h-[100dvh] overflow-hidden bg-background">
      <div className="absolute -right-28 -top-28 size-80 rounded-full bg-[hsl(var(--accent)/.17)] blur-3xl" />
      <div className="absolute -bottom-32 -left-24 size-96 rounded-full bg-[hsl(var(--primary)/.13)] blur-3xl" />
      <div className="relative mx-auto flex w-full max-w-6xl items-center px-5 py-10 lg:px-10">
        <div className="grid w-full overflow-hidden rounded-[28px] border border-card-border bg-card shadow-lg lg:grid-cols-[1.02fr_.98fr]">
          <div className="flex min-h-[560px] flex-col justify-between bg-sidebar p-8 text-sidebar-foreground sm:p-12">
            <BrandMark />
            <div className="max-w-md">
              <p className="mono mb-5 text-[10px] uppercase tracking-[.22em] text-sidebar-primary">private production workspace</p>
              <h1 className="text-4xl font-extrabold leading-[1.03] tracking-[-.07em] sm:text-6xl">Make every asset<br /><span className="text-sidebar-primary">ready to ship.</span></h1>
              <p className="mt-6 max-w-sm text-sm leading-6 text-sidebar-foreground/65">Turn a messy image batch into a consistent library of transparent PNGs and clean SVGs, in one considered pass.</p>
            </div>
            <div className="flex items-center gap-3 border-t border-sidebar-border pt-5 text-xs text-sidebar-foreground/55">
              <span className="size-2 rounded-full bg-sidebar-primary" />
              <span>Invite-only access for the creative team</span>
            </div>
          </div>
          <div className="flex items-center p-8 sm:p-12">
            <div className="w-full max-w-sm">
              <div className="mb-10">
                <p className="mono mb-3 text-[10px] uppercase tracking-[.2em] text-muted-foreground">welcome back</p>
                <h2 className="text-3xl font-extrabold tracking-[-.05em]">Sign in to Studio</h2>
                <p className="mt-2 text-sm text-muted-foreground">Use your invited workspace credentials.</p>
              </div>
              <Form {...form}>
                <form onSubmit={submit} className="space-y-5" noValidate>
                  <FormField
                    control={form.control}
                    name="email"
                    rules={{ required: 'Enter your team email.' }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-bold uppercase tracking-[.1em] text-muted-foreground">Work email</FormLabel>
                        <FormControl>
                          <input {...field} data-testid="input-email" type="email" autoComplete="email" placeholder="name@company.com" className="h-12 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition placeholder:text-muted-foreground/60 focus:border-primary focus:ring-2 focus:ring-primary/15" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="password"
                    rules={{ required: 'Enter your password.' }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-bold uppercase tracking-[.1em] text-muted-foreground">Password</FormLabel>
                        <FormControl>
                          <input {...field} data-testid="input-password" type="password" autoComplete="current-password" placeholder="••••••••••••" className="h-12 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition placeholder:text-muted-foreground/60 focus:border-primary focus:ring-2 focus:ring-primary/15" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="flex justify-end">
                    <button type="button" data-testid="link-forgot-password" onClick={() => onRecover(form.getValues('email'))} className="text-xs font-semibold text-primary underline-offset-4 hover:underline">
                      Forgot password?
                    </button>
                  </div>
                  {error && <div role="alert" data-testid="status-auth-error" className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs leading-5 text-destructive"><CircleAlert size={15} className="mt-0.5 shrink-0" />{error}</div>}
                  <button type="submit" data-testid="button-sign-in" disabled={form.formState.isSubmitting} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-extrabold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
                    {form.formState.isSubmitting ? <Loader2 size={17} className="animate-spin" /> : <ArrowRight size={17} />} {form.formState.isSubmitting ? 'Signing in…' : 'Continue to workspace'}
                  </button>
                </form>
              </Form>
              {devLoginEmail && import.meta.env.DEV && (
                <div className="mt-5 rounded-xl border border-accent/30 bg-accent/10 p-4">
                  <p className="text-xs leading-5 text-muted-foreground">
                    Development-only access is enabled for <span className="font-bold text-foreground">{devLoginEmail}</span>.
                  </p>
                  <button
                    type="button"
                    data-testid="button-dev-login"
                    onClick={onDevLogin}
                    className="mt-3 flex h-10 w-full items-center justify-center rounded-lg border border-primary/30 bg-card text-xs font-extrabold text-primary transition hover:bg-primary/5"
                  >
                    Continue as test user
                  </button>
                </div>
              )}
              <p className="mt-8 text-center text-[11px] leading-5 text-muted-foreground">No account? Access is provisioned by your workspace admin.</p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function getPasswordFlowFromHash(): PasswordFlow | null {
  const type = new URLSearchParams(window.location.hash.slice(1)).get('type');
  if (type === 'invite' || type === 'recovery') {
    persistPasswordFlow(type);
    return type;
  }

  try {
    const savedFlow = window.sessionStorage.getItem(passwordFlowStorageKey);
    return savedFlow === 'invite' || savedFlow === 'recovery' ? savedFlow : null;
  } catch {
    return null;
  }
}

function persistPasswordFlow(flow: PasswordFlow) {
  try {
    window.sessionStorage.setItem(passwordFlowStorageKey, flow);
  } catch {
    // Auth links still work if this browser blocks session storage.
  }
}

function clearSavedPasswordFlow() {
  try {
    window.sessionStorage.removeItem(passwordFlowStorageKey);
  } catch {
    // Nothing else is required if the browser blocks session storage.
  }
}

function clearAuthCallbackUrl() {
  const callbackUrl = new URL(window.location.href);
  if (!callbackUrl.hash && !callbackUrl.searchParams.has('code')) return;
  callbackUrl.hash = '';
  callbackUrl.searchParams.delete('code');
  window.history.replaceState(window.history.state, '', `${callbackUrl.pathname}${callbackUrl.search}`);
}

function StepRail({ job, hasFiles, mode, onHome }: { job?: VectorizerJob; hasFiles: boolean; mode: WorkflowMode; onHome: () => void }) {
  const quick = mode === 'quick';
  const active = !job ? 0 : job.status === 'analyzing' ? 1 : job.status === 'ready' ? 2 : job.status === 'processing' ? (quick ? 2 : 3) : quick ? 3 : 4;
  const steps = quick ? ['Image', 'Analyze', 'Convert', 'Preview'] : ['Upload', 'Analyze', 'Review', 'Process', 'Download'];
  return (
    <div className="hidden w-56 shrink-0 border-r border-sidebar-border bg-sidebar px-6 py-7 text-sidebar-foreground lg:block">
      <BrandMark small onClick={onHome} />
      <div className="mt-20">
        <p className="mono mb-5 text-[10px] uppercase tracking-[.2em] text-sidebar-foreground/45">{quick ? 'quick flow' : 'batch flow'}</p>
        <div className="space-y-1">
          {steps.map((step, index) => {
            const done = index < active || (index === 0 && hasFiles);
            const current = index === active;
            return (
              <div key={step} className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm ${current ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-sidebar-foreground/45'}`}>
                <span className={`flex size-6 items-center justify-center rounded-full border text-[10px] font-bold ${done ? 'border-sidebar-primary bg-sidebar-primary text-sidebar-primary-foreground' : 'border-sidebar-border'}`}>{done ? <Check size={13} /> : `0${index + 1}`}</span>
                <span className={current ? 'font-bold' : ''}>{step}</span>
                {current && <span className="ml-auto size-1.5 rounded-full bg-sidebar-primary" />}
              </div>
            );
          })}
        </div>
      </div>
      <div className="absolute bottom-7 left-6 right-6 border-t border-sidebar-border pt-4 text-[11px] leading-5 text-sidebar-foreground/40">PNG transparency on every source.<br />SVGs when you need them.</div>
    </div>
  );
}

function Topbar({ user, onSignOut, mode, onHome }: { user: WorkspaceUser; onSignOut: () => void; mode: WorkflowMode; onHome: () => void }) {
  const [menu, setMenu] = useState(false);
  const initials = (user.email?.slice(0, 2) || 'VB').toUpperCase();
  return (
    <header className="flex h-[72px] items-center justify-between border-b border-border bg-card/80 px-5 backdrop-blur sm:px-8">
      <div className="flex items-center gap-3 lg:hidden"><BrandMark small onClick={onHome} /></div>
      <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex"><span className="size-1.5 rounded-full bg-primary" /> Workspace / <span className="font-bold text-foreground">{mode === 'quick' ? 'Quick convert' : 'New batch'}</span></div>
      <div className="relative ml-auto">
        <button data-testid="button-account-menu" onClick={() => setMenu(!menu)} className="flex items-center gap-2 rounded-lg p-1.5 transition hover:bg-muted">
          <span className="flex size-8 items-center justify-center rounded-lg bg-secondary mono text-[10px] font-medium text-secondary-foreground">{initials}</span>
          <span className="hidden max-w-36 truncate text-xs font-bold sm:block">{user.email}</span>
          <ChevronRight size={14} className={`text-muted-foreground transition ${menu ? 'rotate-90' : ''}`} />
        </button>
        {menu && <div className="absolute right-0 top-12 z-20 w-44 rounded-xl border border-card-border bg-card p-1.5 shadow-lg">
          <button data-testid="button-sign-out" onClick={onSignOut} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-bold text-muted-foreground transition hover:bg-muted hover:text-foreground"><LogOut size={14} /> Sign out</button>
        </div>}
      </div>
    </header>
  );
}

function UploadPanel({
  onUpload,
  busy,
  options,
  onOptionsChange,
}: {
  onUpload: (files: File[], options: BatchProcessingOptions) => void;
  busy: boolean;
  options: BatchProcessingOptions;
  onOptionsChange: (patch: Partial<BatchProcessingOptions>) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const acceptFiles = (files: File[]) => {
    const accepted = files.filter((file) => file.name.toLowerCase().endsWith('.zip') || ['image/png', 'image/jpeg', 'image/jpg'].includes(file.type));
    if (accepted.length) onUpload(accepted.slice(0, 50), { ...options, quickConvert: false });
  };
  const onInput = (event: ChangeEvent<HTMLInputElement>) => acceptFiles(Array.from(event.target.files || []));
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); acceptFiles(Array.from(event.dataTransfer.files)); };
  return (
    <div className="animate-rise-in">
      <div className="mb-8 max-w-2xl">
        <p className="mono mb-3 text-[10px] uppercase tracking-[.22em] text-primary">01 / start with a batch</p>
        <h1 className="text-4xl font-extrabold leading-[1.04] tracking-[-.07em] sm:text-5xl">Bring the rough cut.<br /><span className="text-primary">We’ll make it consistent.</span></h1>
        <p className="mt-5 max-w-lg text-sm leading-6 text-muted-foreground">Upload a ZIP or up to 50 PNG and JPG files. Choose which steps this batch should run before you upload.</p>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4 transition hover:border-primary/50">
          <input
            type="checkbox"
            checked={options.backgroundRemoval}
            onChange={(event) => onOptionsChange({ backgroundRemoval: event.target.checked })}
            className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
          />
          <span><span className="block text-xs font-bold text-foreground">Remove background</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{options.backgroundRemoval ? 'Export cutout PNGs with transparent backgrounds.' : 'Export PNGs with their original backgrounds intact.'}</span></span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4 transition hover:border-primary/50">
          <input
            type="checkbox"
            checked={options.seoNaming}
            onChange={(event) => onOptionsChange({ seoNaming: event.target.checked })}
            className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
          />
          <span><span className="block text-xs font-bold text-foreground">SEO filename suggestions</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{options.seoNaming ? 'Suggest clear, subject-specific filenames.' : 'Use safe, unique versions of original filenames.'}</span></span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4 transition hover:border-primary/50">
          <input
            type="checkbox"
            checked={options.svgOutput}
            onChange={(event) => onOptionsChange({ svgOutput: event.target.checked })}
            className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
          />
          <span><span className="block text-xs font-bold text-foreground">SVG output</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{options.svgOutput ? 'Include SVGs when the image analysis finds a good fit.' : 'Skip vector tracing and create PNGs only.'}</span></span>
        </label>
      </div>
      <fieldset className="mb-5 rounded-xl border border-border bg-card p-4">
        <legend className="px-1 text-xs font-extrabold text-foreground">Downloaded ZIP layout</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${options.preserveFolderStructure !== false ? 'border-primary/40 bg-primary/5' : 'border-border hover:border-primary/40'}`}>
            <input
              type="radio"
              name="batch-zip-layout"
              data-testid="radio-preserve-folders"
              checked={options.preserveFolderStructure !== false}
              onChange={() => onOptionsChange({ preserveFolderStructure: true })}
              className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
            />
            <span><span className="block text-xs font-bold text-foreground">Preserve uploaded folders</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">Keep each image’s folder path; PNG and SVG sit together there. Names follow your naming setting.</span></span>
          </label>
          <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${options.preserveFolderStructure === false ? 'border-primary/40 bg-primary/5' : 'border-border hover:border-primary/40'}`}>
            <input
              type="radio"
              name="batch-zip-layout"
              data-testid="radio-flat-zip"
              checked={options.preserveFolderStructure === false}
              onChange={() => onOptionsChange({ preserveFolderStructure: false })}
              className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
            />
            <span><span className="block text-xs font-bold text-foreground">Flat ZIP</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">Put all generated files together in the ZIP root.</span></span>
          </label>
        </div>
      </fieldset>
      <div onDragEnter={() => setDragging(true)} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop} className={`group relative flex min-h-[300px] flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed px-6 text-center transition ${dragging ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary/60'}`}>
        <div className="absolute inset-0 opacity-[.16] mesh-bg" />
        <div className="relative flex size-16 items-center justify-center rounded-2xl bg-secondary text-primary shadow-sm"><CloudUpload size={28} strokeWidth={1.6} /></div>
        <h2 className="relative mt-5 text-lg font-extrabold tracking-[-.03em]">{busy ? 'Preparing your batch…' : 'Drop a batch here'}</h2>
        <p className="relative mt-2 text-xs text-muted-foreground">ZIP archive or individual PNG / JPG files</p>
        <button data-testid="button-choose-files" disabled={busy} onClick={() => inputRef.current?.click()} className="relative mt-6 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-extrabold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"><Upload size={15} /> Choose files</button>
        <input data-testid="input-files" ref={inputRef} onChange={onInput} type="file" multiple accept=".zip,.png,.jpg,.jpeg,image/png,image/jpeg" className="hidden" />
      </div>
      <div className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="flex items-center gap-2"><FileArchive size={15} className="text-primary" /> One ZIP, or loose files</div>
        <div className="flex items-center gap-2"><WandSparkles size={15} className="text-primary" /> {options.seoNaming ? 'Names suggested from content' : 'Safe original-based names'}</div>
        <div className="flex items-center gap-2"><PackageCheck size={15} className="text-primary" /> {options.svgOutput ? 'PNG with optional SVG' : 'PNG output only'}</div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = { analyzing: 'Analyzing', ready: 'Ready for review', 'removing-background': 'Removing background', 'converting-png': 'Converting to PNG', vectorizing: 'Tracing SVG', completed: 'Complete', 'png-only': 'PNG ready', failed: 'Needs attention' };
  const active = ['analyzing', 'removing-background', 'converting-png', 'vectorizing'].includes(status);
  const danger = status === 'failed';
  return <span data-testid={`status-pill-${status}`} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold ${danger ? 'bg-destructive/10 text-destructive' : active ? 'bg-accent/20 text-accent-foreground' : status === 'completed' || status === 'ready' || status === 'png-only' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{active && <Loader2 size={11} className="animate-spin" />}{status === 'completed' && <CheckCircle2 size={11} />}{labels[status] || status}</span>;
}

function ReviewPanel({ job, drafts, setDrafts, onProcess, saving, processing, concurrency, setConcurrency }: { job: VectorizerJob; drafts: DraftItem[]; setDrafts: (items: DraftItem[]) => void; onProcess: () => void; saving: boolean; processing: boolean; concurrency: number; setConcurrency: (value: number) => void }) {
  const invalid = drafts.some((item) => !item.suggestedName.trim());
  const hasSvgOutput = job.options.svgOutput;
  const svgCount = drafts.filter((item) => item.includeSvg).length;
  const estimate = estimateConversionTime(job.totalFiles, job.options.backgroundRemoval, svgCount, concurrency);
  const updateDraft = (id: string, patch: Partial<DraftItem>) => setDrafts(drafts.map((item) => item.id === id ? { ...item, ...patch } : item));
  return (
    <div className="animate-rise-in">
      <div className="mb-7 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div><p className="mono mb-3 text-[10px] uppercase tracking-[.22em] text-primary">03 / review batch</p><h1 className="text-3xl font-extrabold tracking-[-.06em] sm:text-4xl">{job.options.seoNaming ? <>A better name is<br /><span className="text-primary">part of the asset.</span></> : <>Review your<br /><span className="text-primary">asset filenames.</span></>}</h1><p className="mt-3 text-sm text-muted-foreground">{job.options.seoNaming ? `We found ${job.totalFiles} images. Refine any suggestions before processing.` : `Safe, unique names based on your originals are ready. Edit any before processing.`}</p></div>
        {hasSvgOutput && <div data-testid="status-batch-svg-count" className="flex items-center gap-2 text-xs text-muted-foreground"><span className="size-2 rounded-full bg-primary" /> {svgCount} SVGs auto-selected</div>}
      </div>
      <BatchSummary job={job} estimate={estimate} estimateNote="Estimated after you start" />
      <div className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-sm">
        <div className="hidden grid-cols-[1.15fr_1.5fr_150px] gap-4 border-b border-border bg-muted/50 px-5 py-3 text-[10px] font-bold uppercase tracking-[.15em] text-muted-foreground sm:grid"><span>Original file</span><span>{job.options.seoNaming ? 'Suggested asset name' : 'Output filename'}</span><span>Status</span></div>
        <div className="divide-y divide-border">
          {drafts.map((item) => (
            <div key={item.id} data-testid={`row-item-${item.id}`} className="grid gap-3 px-4 py-4 sm:grid-cols-[1.15fr_1.5fr_150px] sm:items-center sm:gap-4 sm:px-5">
              <div className="flex min-w-0 items-center gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary"><FileImage size={16} /></div><div className="min-w-0"><p className="truncate text-xs font-bold" title={job.items.find((source) => source.id === item.id)?.originalPath || item.originalName}>{job.items.find((source) => source.id === item.id)?.originalPath || item.originalName}</p><p className="mono mt-1 text-[9px] text-muted-foreground">source image</p></div></div>
              <label className="relative"><span className="mb-1 block text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground sm:hidden">Clean name</span><input data-testid={`input-name-${item.id}`} value={item.suggestedName} onChange={(event) => updateDraft(item.id, { suggestedName: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs font-semibold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15" /></label>
              <div className="flex items-center justify-between gap-2"><StatusPill status={item.status} />{item.error && <span title={item.error} className="text-destructive"><CircleAlert size={14} /></span>}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-col justify-between gap-3 border-t border-border bg-muted/30 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
          <p className="text-xs text-muted-foreground"><span className="font-bold text-foreground">{drafts.length}</span> files · {job.options.backgroundRemoval ? 'transparent PNGs' : 'PNGs with backgrounds intact'}{hasSvgOutput ? ` · ${svgCount} auto-selected SVGs` : ' · PNG only'}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor="processing-concurrency" className="text-[10px] font-bold text-muted-foreground">Parallel workers</label>
            <select
              id="processing-concurrency"
              data-testid="select-processing-concurrency"
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
              className="h-10 rounded-lg border border-input bg-background px-3 text-xs font-bold"
            >
              {Array.from({ length: 8 }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
            <button data-testid="button-process-batch" disabled={invalid || saving || processing || job.status !== 'ready'} onClick={onProcess} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-xs font-extrabold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45">{saving ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}{saving ? 'Saving review…' : processing ? 'Starting process…' : 'Save & process batch'}<ArrowRight size={15} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProcessingPanel({ job, concurrency }: { job: VectorizerJob; concurrency: number }) {
  const analyzing = job.status === 'analyzing';
  const svgEstimateCount = analyzing
    ? job.options.svgOutput ? job.totalFiles : 0
    : job.items.filter((item) => item.includeSvg).length;
  const estimate = estimateConversionTime(job.totalFiles, job.options.backgroundRemoval, svgEstimateCount, concurrency);
  const finishedFiles = analyzing
    ? job.items.filter((item) => item.status !== 'analyzing').length
    : job.completedFiles;
  const progress = job.totalFiles ? Math.round((finishedFiles / job.totalFiles) * 100) : 0;
  return (
    <div className="animate-rise-in mx-auto max-w-2xl py-10 text-center">
      <div className="relative mx-auto mb-7 flex size-24 items-center justify-center rounded-[28px] border border-primary/25 bg-primary/10 text-primary"><div className="absolute inset-2 rounded-[20px] border border-primary/20 progress-line" /><WandSparkles size={34} strokeWidth={1.5} /></div>
      <p className="mono mb-3 text-[10px] uppercase tracking-[.22em] text-primary">{analyzing ? '02 / analyzing batch' : '04 / processing batch'}</p>
      <h1 className="text-4xl font-extrabold tracking-[-.07em]">{analyzing ? <>Reading the image<br /><span className="text-primary">set and its options.</span></> : <>Making the set<br /><span className="text-primary">hang together.</span></>}</h1>
      <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-muted-foreground">{analyzing ? 'Preparing filenames and checking which images are a good fit for SVG.' : `${job.options.backgroundRemoval ? 'Backgrounds are being removed.' : 'Images are being converted to PNG with their backgrounds intact.'} ${job.options.svgOutput ? 'Suitable images are also being traced into SVG.' : 'SVG output is disabled for this batch.'}`} You can leave this tab open.</p>
      <div className="mx-auto mt-6 max-w-2xl text-left">
        <BatchSummary
          job={job}
          estimate={estimate}
          estimateNote={analyzing ? 'Estimated after review' : 'Estimated total conversion'}
        />
        {analyzing && job.options.svgOutput && <p className="-mt-3 mb-5 text-[10px] leading-4 text-muted-foreground">This early estimate allows for all images to be SVG candidates; it updates after the image review.</p>}
      </div>
      <div className="mx-auto mt-10 max-w-2xl rounded-2xl border border-card-border bg-card p-5 text-left shadow-sm">
        <div className="mb-3 flex items-center justify-between text-xs"><span className="font-bold text-foreground">{finishedFiles} of {job.totalFiles} assets {analyzing ? 'analyzed' : 'processed'}</span><span className="mono text-primary">{progress}%</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${Math.max(4, progress)}%` }} /></div>
         <div className="mt-4 flex justify-between text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> {analyzing ? 'Checking each image' : 'Working through your batch'}</span><span>Auto-refreshing</span></div>
        <div className="mt-4 max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {job.items.map((item) => (
            <div key={item.id} data-testid={`processing-row-${item.id}`} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold text-foreground">{item.originalPath || item.originalName}</p>
                <p className="truncate text-[10px] text-muted-foreground">{item.suggestedName}{item.pngReady ? '.png' : ''}{item.svgReady ? ' + .svg' : ''}</p>
                {item.error && <p className="mt-1 truncate text-[10px] text-destructive">{item.error}</p>}
              </div>
              <StatusPill status={item.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultsPanel({ job, onDownload, downloading, onFresh }: { job: VectorizerJob; onDownload: () => void; downloading: boolean; onFresh: () => void }) {
  const completed = job.items.filter((item) => item.status === 'completed' || item.status === 'png-only');
  const failed = job.items.filter((item) => item.status === 'failed');
  return (
    <div className="animate-rise-in">
      <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="mono mb-3 text-[10px] uppercase tracking-[.22em] text-primary">05 / delivery ready</p><h1 className="text-4xl font-extrabold tracking-[-.07em]">The set is<br /><span className="text-primary">ready to move.</span></h1><p className="mt-4 text-sm text-muted-foreground">{completed.length} assets prepared{failed.length ? ` · ${failed.length} need attention` : ''}.</p></div><div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><CheckCircle2 size={30} strokeWidth={1.6} /></div></div>
      <div className="rounded-2xl border border-card-border bg-card shadow-sm">
        <div className="flex flex-col justify-between gap-4 border-b border-border p-5 sm:flex-row sm:items-center sm:px-6"><div className="flex items-center gap-3"><div className="flex size-10 items-center justify-center rounded-xl bg-secondary text-primary"><FileArchive size={19} /></div><div><p className="text-sm font-extrabold">vector-batch-assets.zip</p><p className="mono mt-1 text-[10px] text-muted-foreground">{completed.length} assets · {job.options.backgroundRemoval ? 'transparent PNG' : 'PNG with background intact'}{job.options.svgOutput ? ' + selected SVG' : ''}</p></div></div><button data-testid="button-download-zip" onClick={onDownload} disabled={downloading || completed.length === 0} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-xs font-extrabold text-primary-foreground transition hover:opacity-90 disabled:opacity-60">{downloading ? <Loader2 size={15} className="animate-spin" /> : <ArrowDownToLine size={15} />}{downloading ? 'Preparing ZIP…' : 'Download ZIP'}</button></div>
        <div className="max-h-[32rem] divide-y divide-border overflow-y-auto">
          {job.items.map((item) => <div key={item.id} data-testid={`result-row-${item.id}`} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div className="flex min-w-0 items-center gap-3"><span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${item.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>{item.status === 'failed' ? <CircleAlert size={14} /> : <Check size={14} />}</span><div className="min-w-0"><p className="truncate text-[10px] text-muted-foreground">{item.originalPath || item.originalName}</p><p className="truncate text-xs font-bold">{item.suggestedName}{item.pngReady ? '.png' : ''}{item.svgReady && item.includeSvg ? ' + .svg' : ''}</p>{item.error && <p className="mt-1 truncate text-[10px] text-destructive">{item.error}</p>}</div></div><div className="flex items-center gap-2 pl-10 sm:pl-0">{item.status === 'failed' ? <StatusPill status="failed" /> : <>{item.pngReady && <span className="rounded bg-secondary px-2 py-1 mono text-[9px] text-secondary-foreground">PNG</span>}{item.svgReady && item.includeSvg && <span className="rounded bg-accent/20 px-2 py-1 mono text-[9px] text-accent-foreground">SVG</span>}</>}</div></div>)}
        </div>
      </div>
      {failed.length > 0 && <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive"><p className="font-bold">Some files could not be completed</p><p className="mt-1 opacity-80">Review the error details above and try a fresh batch if needed.</p></div>}
      <div className="mt-7 flex flex-col items-center justify-between gap-3 sm:flex-row"><p className="text-xs text-muted-foreground">Need to make another set?</p><button data-testid="button-new-batch" onClick={onFresh} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-xs font-extrabold transition hover:bg-muted"><Plus size={15} /> Start a new batch</button></div>
    </div>
  );
}

function Workspace({ user, client, onSignOut }: { user: WorkspaceUser; client: SupabaseClient; onSignOut: () => void }) {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(() => typeof window !== 'undefined' ? localStorage.getItem('vector-batch-job') : null);
  const initialJobId = typeof window !== 'undefined' ? localStorage.getItem('vector-batch-job') : null;
  const initialMode: WorkflowMode = initialJobId && localStorage.getItem(`vector-batch-mode:${initialJobId}`) !== 'quick' ? 'batch' : 'quick';
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>(initialMode);
  const [uploadMode, setUploadMode] = useState<WorkflowMode>(initialMode);
  const [batchOptions, setBatchOptions] = useState<BatchProcessingOptions>(defaultBatchOptions);
  const [quickOptions, setQuickOptions] = useState<QuickConvertOptions>(defaultQuickOptions);
  const [quickFile, setQuickFile] = useState<File | null>(null);
  const [quickUploadPending, setQuickUploadPending] = useState(false);
  const [quickUploadError, setQuickUploadError] = useState('');
  const [quickProcessError, setQuickProcessError] = useState('');
  const [quickStartPending, setQuickStartPending] = useState(false);
  const [quickNameSyncPending, setQuickNameSyncPending] = useState(false);
  const [localBatchId, setLocalBatchId] = useState<string | null>(null);
  const [localArchiveRefreshKey, setLocalArchiveRefreshKey] = useState(0);
  const [parallelConcurrency, setParallelConcurrency] = useState(1);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [notice, setNotice] = useState('');
  const initialized = useRef<string | null>(null);
  const lastSavedJobSignature = useRef('');
  const autoArchivedJobId = useRef<string | null>(null);
  const quickProcessStartedJobId = useRef<string | null>(null);
  const createJob = useCreateVectorizerJob();
  const updateItems = useUpdateVectorizerJobItems();
  const processJob = useProcessVectorizerJob();
  const deleteJob = useDeleteVectorizerJob();
  const regenerateQuickName = useRegenerateVectorizerJobItemName();
  const jobQuery = useGetVectorizerJob(jobId || '', { query: { enabled: Boolean(jobId), queryKey: getGetVectorizerJobQueryKey(jobId || ''), refetchInterval: (query) => { if (query.state.error) return false; const state = query.state.data?.status; return !state || state === 'analyzing' || state === 'processing' ? 1800 : false; }, refetchIntervalInBackground: true, refetchOnMount: 'always' } });
  const downloadQuery = useDownloadVectorizerJob(jobId || '', { request: { responseType: 'blob' }, query: { enabled: false, queryKey: getDownloadVectorizerJobQueryKey(jobId || '') } });
  const job = jobQuery.data;
  const quickItem = workflowMode === 'quick' ? job?.items[0] : undefined;
  const quickPngQuery = useGetVectorizerJobItemPng(jobId || '', quickItem?.id || '', {
    request: { responseType: 'blob' },
    query: {
      enabled: Boolean(jobId && workflowMode === 'quick' && job?.status === 'completed' && quickItem?.pngReady),
      queryKey: getGetVectorizerJobItemPngQueryKey(jobId || '', quickItem?.id || ''),
      retry: false,
    },
  });
  const quickSvgQuery = useGetVectorizerJobItemSvg(jobId || '', quickItem?.id || '', {
    request: { responseType: 'blob' },
    query: {
      enabled: Boolean(jobId && workflowMode === 'quick' && job?.status === 'completed' && quickItem?.svgReady),
      queryKey: getGetVectorizerJobItemSvgQueryKey(jobId || '', quickItem?.id || ''),
      retry: false,
    },
  });
  const quickPngPreviewUrl = useObjectUrl(quickPngQuery.data);
  const quickSvgPreviewUrl = useObjectUrl(quickSvgQuery.data);
  const [quickOriginalPreviewUrl, setQuickOriginalPreviewUrl] = useState<string | null>(null);

  const startQuickProcessing = useCallback(async (targetJobId: string) => {
    if (quickProcessStartedJobId.current === targetJobId) return;
    quickProcessStartedJobId.current = targetJobId;
    setQuickProcessError('');
    setQuickStartPending(true);
    try {
      await processJob.mutateAsync({ jobId: targetJobId, data: { concurrency: 1 } });
      qc.setQueryData(getGetVectorizerJobQueryKey(targetJobId), (current: VectorizerJob | undefined) => (
        current ? { ...current, status: 'processing', completedFiles: 0 } : current
      ));
    } catch (error) {
      quickProcessStartedJobId.current = null;
      setQuickProcessError(error instanceof Error ? error.message : 'Could not start this conversion. Try again.');
    } finally {
      setQuickStartPending(false);
    }
  }, [processJob.mutateAsync, qc]);

  useEffect(() => { if (jobId) localStorage.setItem('vector-batch-job', jobId); else localStorage.removeItem('vector-batch-job'); }, [jobId]);
  useEffect(() => {
    lastSavedJobSignature.current = '';
  }, [localBatchId]);
  useEffect(() => {
    if (!jobId) {
      setLocalBatchId(null);
      return;
    }
    let active = true;
    void listSavedBatches(user.id).then((batches) => {
      if (!active) return;
      const saved = batches.find((batch) => batch.jobId === jobId);
      if (saved) {
        const savedMode = saved.processingOptions?.quickConvert === true ? 'quick' : 'batch';
        setLocalBatchId(saved.id);
        setWorkflowMode(savedMode);
        setUploadMode(savedMode);
        if (saved.processingOptions) {
          setBatchOptions({
            backgroundRemoval: saved.processingOptions.backgroundRemoval,
            seoNaming: saved.processingOptions.seoNaming,
            svgOutput: saved.processingOptions.svgOutput,
            preserveFolderStructure: saved.processingOptions.preserveFolderStructure ?? true,
          });
          setQuickOptions({
            backgroundRemoval: saved.processingOptions.backgroundRemoval,
            seoNaming: saved.processingOptions.seoNaming,
            svgOutput: saved.processingOptions.svgOutput,
          });
        }
      }
    }).catch(() => {
      // Existing server jobs remain available even if this browser has no local record.
    });
    return () => { active = false; };
  }, [jobId, user.id]);
  useEffect(() => {
    let active = true;
    let previewUrl: string | null = null;
    if (quickFile) {
      previewUrl = createBlobObjectUrl(quickFile);
      setQuickOriginalPreviewUrl(previewUrl);
    } else if (workflowMode === 'quick' && localBatchId) {
      setQuickOriginalPreviewUrl(null);
      void getSavedBatch(localBatchId).then((saved) => {
        const source = saved?.sourceFiles[0];
        if (active && source) {
          previewUrl = createBlobObjectUrl(source.blob);
          setQuickOriginalPreviewUrl(previewUrl);
        }
      }).catch(() => {
        if (active) setQuickOriginalPreviewUrl(null);
      });
    } else {
      setQuickOriginalPreviewUrl(null);
    }
    return () => {
      active = false;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [quickFile, workflowMode, localBatchId]);
  useEffect(() => {
    if (workflowMode !== 'quick' || !localBatchId || quickFile) return;
    let active = true;
    void getSavedBatch(localBatchId).then((saved) => {
      const source = saved?.sourceFiles[0];
      if (active && source) {
        setQuickFile(new File([source.blob], source.name, {
          type: source.type,
          lastModified: source.lastModified,
        }));
      }
    }).catch(() => {
      // The output can still be previewed if this browser no longer has its original.
    });
    return () => { active = false; };
  }, [workflowMode, localBatchId, quickFile]);
  useEffect(() => {
    if (workflowMode !== 'quick' || !jobId || job?.status !== 'ready' || quickProcessError) return;
    void startQuickProcessing(jobId);
  }, [workflowMode, jobId, job?.status, quickProcessError, startQuickProcessing]);
  useEffect(() => {
    if (workflowMode === 'quick' && job) {
      setQuickOptions({
        backgroundRemoval: job.options.backgroundRemoval,
        seoNaming: job.options.seoNaming,
        svgOutput: job.options.svgOutput,
      });
    }
  }, [workflowMode, job?.id]);
  useEffect(() => {
    if (job && initialized.current !== job.id) {
      initialized.current = job.id;
      setDrafts(job.items.map((item) => ({ ...item })));
    } else if (job && job.status !== 'ready') {
      setDrafts(job.items.map((item) => ({ ...item })));
    }
  }, [job]);
  useEffect(() => {
    if (!job || !localBatchId) return;
    const signature = JSON.stringify(job);
    if (signature === lastSavedJobSignature.current) return;
    lastSavedJobSignature.current = signature;
    void updateSavedBatch(localBatchId, (batch) => ({
      ...batch,
      jobId: job.id,
      job,
      updatedAt: Date.now(),
    })).then((updated) => {
      if (updated) setLocalArchiveRefreshKey((value) => value + 1);
    }).catch(() => {
      setNotice("The batch is still on the server, but its latest status could not be saved in this browser.");
    });
  }, [job, localBatchId]);
  useEffect(() => {
    if (!job || job.status !== 'completed' || !jobId || !localBatchId || autoArchivedJobId.current === job.id) return;
    autoArchivedJobId.current = job.id;
    void downloadQuery.refetch().then(async (result) => {
      if (!result.data) throw result.error ?? new Error("Result archive could not be downloaded.");
      await saveResultArchive(localBatchId, user.id, result.data!);
      await updateSavedBatch(localBatchId, (batch) => ({ ...batch, job, updatedAt: Date.now() }));
      setLocalArchiveRefreshKey((value) => value + 1);
    }).catch(() => {
      setNotice("Processing finished, but the result ZIP could not be saved in this browser. Use Download ZIP now to keep a copy.");
    });
  }, [job, jobId, localBatchId, downloadQuery.refetch]);

  const handleUpload = async (files: File[], options: BatchProcessingOptions) => {
    const quick = options.quickConvert === true;
    const mode: WorkflowMode = quick ? 'quick' : 'batch';
    const normalizedOptions = {
      ...options,
      preserveFolderStructure: options.preserveFolderStructure ?? true,
    };
    setWorkflowMode(mode);
    setUploadMode(mode);
    setNotice('');
    if (quick) {
      setQuickUploadPending(true);
      setQuickUploadError('');
      setQuickProcessError('');
      quickProcessStartedJobId.current = null;
    }
    let savedBatchId: string | null = null;
    try {
      const localBatch = createSavedBatch(user.id, files, normalizedOptions);
      await saveBatch(localBatch);
      savedBatchId = localBatch.id;
      setLocalBatchId(localBatch.id);
      setLocalArchiveRefreshKey((value) => value + 1);
      await requestPersistentBrowserStorage();
    } catch {
      const message = "Browser storage is full or unavailable. Clear saved batches before uploading so the original files can be kept locally.";
      setNotice(message);
      if (quick) setQuickUploadError(message);
      if (quick) setQuickUploadPending(false);
      return;
    }

    try {
      const accepted = await createJob.mutateAsync({
        data: {
          files,
          backgroundRemoval: options.backgroundRemoval,
          seoNaming: options.seoNaming,
          svgOutput: options.svgOutput,
          preserveFolderStructure: normalizedOptions.preserveFolderStructure,
        },
      });
      localStorage.setItem(`vector-batch-mode:${accepted.id}`, mode);
      if (savedBatchId) {
        await updateSavedBatch(savedBatchId, (batch) => ({
          ...batch,
          jobId: accepted.id,
          updatedAt: Date.now(),
        }));
      }
      setJobId(accepted.id);
      initialized.current = null;
      setLocalArchiveRefreshKey((value) => value + 1);
    } catch {
      const message = "Upload failed, but the original files are saved under Local copies. Try again when the server is available.";
      setNotice(message);
      if (quick) setQuickUploadError(message);
    } finally {
      if (quick) setQuickUploadPending(false);
    }
  };
  const handleProcess = async () => {
    if (!jobId || !job) return;
    setNotice('');
    try {
      const updated = await updateItems.mutateAsync({ jobId, data: { items: drafts.map((item) => ({ id: item.id, suggestedName: item.suggestedName.trim(), includeSvg: item.includeSvg })) } });
      qc.setQueryData(getGetVectorizerJobQueryKey(jobId), updated);
      await processJob.mutateAsync({ jobId, data: { concurrency: parallelConcurrency } });
      qc.setQueryData(getGetVectorizerJobQueryKey(jobId), (current: VectorizerJob | undefined) => current ? { ...current, status: 'processing' } : current);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not start processing.'); }
  };
  const handleFresh = async () => {
    if (jobId) {
      localStorage.removeItem(`vector-batch-mode:${jobId}`);
      try { await deleteJob.mutateAsync({ jobId }); } catch { /* best effort cleanup */ }
    }
    if (localBatchId) {
      try {
        await updateSavedBatch(localBatchId, (batch) => ({
          ...batch,
          jobId: null,
          updatedAt: Date.now(),
        }));
        setLocalArchiveRefreshKey((value) => value + 1);
      } catch {
        // Keep the local files even if the server reference could not be cleared.
      }
    }
    initialized.current = null;
    setJobId(null);
    setLocalBatchId(null);
    setDrafts([]);
    setNotice('');
    setQuickUploadError('');
    setQuickProcessError('');
    quickProcessStartedJobId.current = null;
  };

  const handleLogoHome = () => {
    // Leave the server job and its local archive intact; just return to the workflow chooser.
    setJobId(null);
    initialized.current = null;
    setWorkflowMode('batch');
    setUploadMode('batch');
    setDrafts([]);
    setQuickFile(null);
    setQuickUploadPending(false);
    setQuickUploadError('');
    setQuickProcessError('');
    setNotice('');
  };

  const handleQuickFileChange = (file: File | null) => {
    setQuickUploadError('');
    setQuickProcessError('');
    if (jobId) void handleFresh();
    setQuickFile(file);
  };
  const handleQuickReset = async () => {
    await handleFresh();
    setQuickFile(null);
    setQuickUploadPending(false);
    setQuickUploadError('');
    setQuickProcessError('');
  };
  const handleQuickConvert = async () => {
    if (!quickFile) return;
    setNotice('');
    setQuickUploadError('');
    setQuickProcessError('');
    if (jobId && job?.status === 'ready') {
      quickProcessStartedJobId.current = null;
      await startQuickProcessing(job.id);
      return;
    }
    if (jobId) await handleFresh();
    await handleUpload([quickFile], { ...quickOptions, quickConvert: true });
  };
  const handleQuickDownload = async (format: 'png' | 'svg') => {
    const query = format === 'png' ? quickPngQuery : quickSvgQuery;
    const result = query.data ? { data: query.data } : await query.refetch();
    if (!result.data || !quickItem) {
      setNotice(`The ${format.toUpperCase()} output could not be opened. Please try again.`);
      return;
    }
    downloadBlob(result.data, `${quickItem.suggestedName}.${format}`);
  };
  const handleRegenerateQuickName = async () => {
    if (!jobId || !quickItem || job?.status !== 'completed' || !job.options.seoNaming) return;
    setNotice('');
    try {
      const updatedJob = await regenerateQuickName.mutateAsync({
        jobId,
        itemId: quickItem.id,
      });
      qc.setQueryData(getGetVectorizerJobQueryKey(jobId), updatedJob);

      if (localBatchId) {
        setQuickNameSyncPending(true);
        try {
          const archiveResult = await downloadQuery.refetch();
          if (!archiveResult.data) {
            throw archiveResult.error ?? new Error('The updated ZIP could not be prepared.');
          }
          await saveResultArchive(localBatchId, user.id, archiveResult.data);
          await updateSavedBatch(localBatchId, (batch) => ({
            ...batch,
            job: updatedJob,
            updatedAt: Date.now(),
          }));
          setLocalArchiveRefreshKey((value) => value + 1);
        } catch {
          setNotice('The new filename is ready, but the saved ZIP could not be refreshed. Download the ZIP again to include the new name.');
        } finally {
          setQuickNameSyncPending(false);
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not generate another filename. Your current output is unchanged.');
    }
  };
  const handleDownload = async () => {
    setNotice('');
    if (localBatchId) {
      try {
        const savedArchive = await getSavedResultArchive(localBatchId);
        if (savedArchive) {
          const url = URL.createObjectURL(savedArchive);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = 'vector-batch-assets.zip';
          anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          return;
        }
      } catch {
        // Fall back to the live server download.
      }
    }
    const result = await downloadQuery.refetch();
    if (result.data) {
      if (localBatchId) {
        try {
          await saveResultArchive(localBatchId, user.id, result.data!);
          setLocalArchiveRefreshKey((value) => value + 1);
        } catch {
          setNotice("The ZIP downloaded, but this browser could not save a local copy. Clear old batches to free space.");
        }
      }
      const url = URL.createObjectURL(result.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'vector-batch-assets.zip';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (result.error) setNotice('The ZIP could not be prepared. Please try again.');
  };
  const handleRetryFromLocal = async (savedBatchId = localBatchId) => {
    if (!savedBatchId) return;
    setNotice('');
    let quick = false;
    try {
      const saved = await getSavedBatch(savedBatchId);
      if (!saved?.sourceFiles.length) {
        setNotice("No local source files were found for this batch.");
        return;
      }
      const options = saved.processingOptions ?? defaultBatchOptions;
      quick = options.quickConvert === true;
      const mode: WorkflowMode = quick ? 'quick' : 'batch';
      setWorkflowMode(mode);
      setUploadMode(mode);
      if (quick) {
        setQuickFile(saved.sourceFiles.length === 1 ? new File([saved.sourceFiles[0].blob], saved.sourceFiles[0].name, {
          type: saved.sourceFiles[0].type,
          lastModified: saved.sourceFiles[0].lastModified,
        }) : null);
        setQuickOptions({
          backgroundRemoval: options.backgroundRemoval,
          seoNaming: options.seoNaming,
          svgOutput: options.svgOutput,
        });
        setQuickUploadPending(true);
        setQuickUploadError('');
        setQuickProcessError('');
      }
      const files = saved.sourceFiles.map((source) => new File([source.blob], source.name, {
        type: source.type,
        lastModified: source.lastModified,
      }));
      const accepted = await createJob.mutateAsync({
        data: {
          files,
          backgroundRemoval: options.backgroundRemoval,
          seoNaming: options.seoNaming,
          svgOutput: options.svgOutput,
          preserveFolderStructure: options.preserveFolderStructure ?? true,
        },
      });
      localStorage.setItem(`vector-batch-mode:${accepted.id}`, mode);
      await updateSavedBatch(savedBatchId, (batch) => ({
        ...batch,
        jobId: accepted.id,
        job: null,
        updatedAt: Date.now(),
      }));
      setLocalBatchId(savedBatchId);
      setJobId(accepted.id);
      initialized.current = null;
      setLocalArchiveRefreshKey((value) => value + 1);
    } catch {
      const message = "The saved originals could not be re-uploaded. Download them from Local copies and try again.";
      setNotice(message);
      if (quick) setQuickUploadError(message);
    } finally {
      if (quick) setQuickUploadPending(false);
    }
  };

  const quickStage: QuickConvertStage = quickUploadError || quickProcessError
    ? 'failed'
    : quickUploadPending || job?.status === 'analyzing'
      ? 'analyzing'
      : quickStartPending || job?.status === 'ready' || job?.status === 'processing'
        ? 'processing'
        : job?.status === 'completed'
          ? quickItem?.pngReady ? 'complete' : 'failed'
        : job?.status === 'failed' || quickItem?.status === 'failed'
          ? 'failed'
          : quickFile ? 'selected' : 'empty';
  const quickStatusMessage = quickUploadPending
    ? 'Saving your original and starting the analysis.'
    : job?.status === 'analyzing'
      ? 'Checking the image and preparing its output settings.'
      : job?.status === 'ready' || quickStartPending
        ? 'Analysis is complete. Starting the single-image conversion.'
        : job?.status === 'processing'
          ? `${job.completedFiles} of ${job.totalFiles} image converted.`
          : quickItem?.error || job?.error || null;
  const quickProgress = quickStage === 'complete'
    ? 100
    : job?.status === 'analyzing'
      ? 12
      : job?.status === 'ready'
        ? 45
        : job?.status === 'processing'
          ? 55 + Math.round((job.completedFiles / Math.max(job.totalFiles, 1)) * 45)
          : quickUploadPending ? 5 : 0;
  const quickPanel = (
    <QuickConvertPanel
      file={quickFile}
      options={quickOptions}
      stage={quickStage}
      statusMessage={quickStatusMessage}
      progress={quickProgress}
      suggestedName={quickItem?.suggestedName || null}
      originalPreviewUrl={quickOriginalPreviewUrl}
      pngPreviewUrl={quickPngPreviewUrl}
      svgPreviewUrl={quickSvgPreviewUrl}
      error={quickUploadError || quickProcessError || job?.error || null}
      regeneratingName={regenerateQuickName.isPending || quickNameSyncPending}
      onFileChange={handleQuickFileChange}
      onOptionsChange={setQuickOptions}
      onConvert={() => { void handleQuickConvert(); }}
      onRegenerateName={() => { void handleRegenerateQuickName(); }}
      onDownloadPng={() => { void handleQuickDownload('png'); }}
      onDownloadSvg={() => { void handleQuickDownload('svg'); }}
      onReset={() => { void handleQuickReset(); }}
    />
  );

  const activeView = useMemo(() => {
    if (!jobId) return 'upload';
    if (!job) return jobQuery.isError ? 'expired' : 'loading';
    if (job.status === 'analyzing') return 'analyzing';
    if (job.status === 'ready') return 'review';
    if (job.status === 'processing') return 'processing';
    if (job.status === 'completed' || job.status === 'failed') return 'results';
    return 'upload';
  }, [jobId, job, jobQuery.isError]);

  return (
    <div className="flex min-h-[100dvh] bg-background">
      <StepRail job={job} hasFiles={Boolean(jobId)} mode={workflowMode} onHome={handleLogoHome} />
      <div className="min-w-0 flex-1">
        <Topbar user={user} onSignOut={onSignOut} mode={workflowMode} onHome={handleLogoHome} />
        <LocalArchivePanel
          ownerId={user.id}
          refreshKey={localArchiveRefreshKey}
          onOpenJob={(batchId, savedJobId, quickConvert) => {
            const mode: WorkflowMode = quickConvert ? 'quick' : 'batch';
            setLocalBatchId(batchId);
            setJobId(savedJobId);
            setWorkflowMode(mode);
            setUploadMode(mode);
            setQuickUploadError('');
            setQuickProcessError('');
            quickProcessStartedJobId.current = null;
            setNotice('');
          }}
          onRetryBatch={(batchId) => { void handleRetryFromLocal(batchId); }}
          onDeleteBatch={(batchId) => {
            if (batchId === localBatchId) setLocalBatchId(null);
          }}
        />
        <main className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
          {activeView === 'loading' || jobQuery.isLoading ? <div className="space-y-5"><div className="skeleton h-5 w-32 rounded" /><div className="skeleton h-24 w-3/4 rounded-xl" /><div className="skeleton h-64 w-full rounded-2xl" /></div> :
            activeView === 'expired' ? <div data-testid="status-expired-batch" className="mx-auto max-w-lg rounded-2xl border border-card-border bg-card p-7 text-center shadow-sm"><div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><CircleAlert size={22} /></div><h1 className="text-2xl font-extrabold tracking-tight">This temporary batch is no longer available.</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">The server copy expired or restarted. Your originals remain saved in this browser.</p><div className="mt-5 flex flex-wrap justify-center gap-2">{localBatchId && <button data-testid="button-retry-local-batch" onClick={() => void handleRetryFromLocal()} disabled={createJob.isPending} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-xs font-extrabold text-primary-foreground"><RefreshCw size={15} /> Re-upload saved originals</button>}<button data-testid="button-expired-new-batch" onClick={handleFresh} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border px-4 text-xs font-extrabold"><Plus size={15} /> Start a new batch</button></div></div> :
              activeView === 'upload' ? <>
                <section aria-labelledby="conversion-choice-title" className="mb-8">
                  <div className="mb-3">
                    <p className="mono text-[10px] uppercase tracking-[.2em] text-primary">Choose a workflow</p>
                    <h1 id="conversion-choice-title" className="mt-1 text-xl font-extrabold tracking-tight">What would you like to convert?</h1>
                  </div>
                  <div role="tablist" aria-label="Conversion workflow" className="grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={uploadMode === 'quick'}
                      data-testid="tab-quick-convert"
                      onClick={() => { setUploadMode('quick'); setWorkflowMode('quick'); }}
                      className={`flex min-h-24 items-start gap-3 rounded-xl border p-4 text-left transition-colors ${uploadMode === 'quick' ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20' : 'border-card-border bg-card hover:border-primary/50'}`}
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary"><FileImage size={19} /></span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-extrabold text-foreground">Single image <span className="mono rounded-full bg-muted px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">Quick</span></span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">Convert one PNG or JPG and preview it right away.</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={uploadMode === 'batch'}
                      data-testid="tab-zip-batch"
                      onClick={() => { setUploadMode('batch'); setWorkflowMode('batch'); }}
                      className={`flex min-h-24 items-start gap-3 rounded-xl border p-4 text-left transition-colors ${uploadMode === 'batch' ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20' : 'border-card-border bg-card hover:border-primary/50'}`}
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary"><FileArchive size={19} /></span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-extrabold text-foreground">Bulk batch <span className="mono rounded-full bg-muted px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">ZIP or files</span></span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">Upload one ZIP archive or convert up to 50 PNG/JPG files together.</span>
                      </span>
                    </button>
                  </div>
                </section>
                {uploadMode === 'quick' ? quickPanel : <UploadPanel
                  onUpload={handleUpload}
                  busy={createJob.isPending}
                  options={batchOptions}
                  onOptionsChange={(patch) => setBatchOptions((current) => ({ ...current, ...patch }))}
                />}
              </> :
                workflowMode === 'quick' ? quickPanel :
                activeView === 'analyzing' ? <ProcessingPanel job={job!} concurrency={parallelConcurrency} /> :
                activeView === 'review' ? <ReviewPanel job={job!} drafts={drafts} setDrafts={setDrafts} onProcess={handleProcess} saving={updateItems.isPending} processing={processJob.isPending} concurrency={parallelConcurrency} setConcurrency={setParallelConcurrency} /> :
                  activeView === 'processing' ? <ProcessingPanel job={job!} concurrency={parallelConcurrency} /> :
                    <ResultsPanel job={job!} onDownload={handleDownload} downloading={downloadQuery.isFetching} onFresh={handleFresh} />}
          {notice && <div data-testid="status-workspace-error" className="mt-6 flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive"><span className="flex items-center gap-2"><CircleAlert size={15} />{notice}</span><button data-testid="button-dismiss-error" onClick={() => setNotice('')}><X size={15} /></button></div>}
          {job?.error && <div data-testid="status-job-error" className="mt-6 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive"><span className="flex items-center gap-2 font-bold"><CircleAlert size={15} /> Batch processing error</span><p className="mt-1 pl-5 opacity-80">{job.error}</p></div>}
        </main>
      </div>
    </div>
  );
}

function Home() {
  const configQuery = useGetPublicConfig({ query: { queryKey: getGetPublicConfigQueryKey(), retry: false } });
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [passwordFlow, setPasswordFlow] = useState<PasswordFlow | null>(getPasswordFlowFromHash);
  const [authView, setAuthView] = useState<'sign-in' | 'recovery'>('sign-in');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const devLoginEmail = import.meta.env.DEV ? configQuery.data?.devLoginEmail ?? null : null;

  useEffect(() => {
    const config = configQuery.data;
    if (!config?.supabaseUrl || !config.supabaseAnonKey) return;
    const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    setClient(supabase);
    setAuthTokenGetter(async () => (await supabase.auth.getSession()).data.session?.access_token ?? null);
    let active = true;
    const { data: listener } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY') {
        setPasswordFlow('recovery');
        persistPasswordFlow('recovery');
      }
      if (session) {
        clearPersistedDevelopmentSession();
        clearAuthCallbackUrl();
      }
      setUser(session?.user ?? getPersistedDevelopmentUser(devLoginEmail));
      setAuthLoading(false);
    });
    supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      if (!active) return;
       if (data.session) {
         clearPersistedDevelopmentSession();
         clearAuthCallbackUrl();
       }
       setUser(data.session?.user ?? getPersistedDevelopmentUser(devLoginEmail));
      setAuthLoading(false);
    }).catch(() => {
      if (!active) return;
       setUser(getPersistedDevelopmentUser(devLoginEmail));
      setAuthLoading(false);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
      setAuthTokenGetter(null);
    };
  }, [configQuery.data, devLoginEmail]);

  const loadingState = <main className="mesh-bg flex min-h-[100dvh] items-center justify-center bg-background p-5"><div className="w-full max-w-sm space-y-4"><div className="skeleton mx-auto h-10 w-40 rounded-lg" /><div className="skeleton h-64 rounded-2xl" /></div></main>;
  const clearPasswordFlow = () => {
    setPasswordFlow(null);
    clearSavedPasswordFlow();
    clearAuthCallbackUrl();
  };
  const enterDevelopmentSession = () => {
    if (!devLoginEmail) return;
    clearPasswordFlow();
    persistDevelopmentSession();
    setUser({ id: `dev:${devLoginEmail}`, email: devLoginEmail });
  };
  const handleSignOut = () => {
    if (user?.id.startsWith('dev:')) {
      clearPersistedDevelopmentSession();
      setUser(null);
      return;
    }
    if (client) void client.auth.signOut();
  };

  if (configQuery.isError) return <SetupState message="The browser-safe Supabase configuration could not be loaded. Ask your workspace administrator to configure the API server, then retry." retry={() => configQuery.refetch()} />;
  if (configQuery.isLoading) return loadingState;
  if (!configQuery.data?.supabaseUrl || !configQuery.data.supabaseAnonKey) return <SetupState message="The browser-safe Supabase configuration could not be loaded. Ask your workspace administrator to configure the API server, then retry." retry={() => configQuery.refetch()} />;
  if (authLoading) return loadingState;
  if (!client) return <SetupState message="Supabase is unavailable in this browser. Refresh the page or ask your workspace administrator for help." retry={() => window.location.reload()} />;
  if (passwordFlow) {
    if (!user) return <AuthLinkExpired type={passwordFlow} onBack={clearPasswordFlow} />;
    return <PasswordSetup client={client} onComplete={clearPasswordFlow} />;
  }
  if (authView === 'recovery' && !user) {
    return <PasswordRecoveryRequest
      client={client}
      initialEmail={recoveryEmail}
      onBack={() => { setAuthView('sign-in'); setRecoveryEmail(''); }}
    />;
  }
  return user
    ? <Workspace key={user.id} user={user} client={client} onSignOut={handleSignOut} />
    : <SignIn
        client={client}
        devLoginEmail={devLoginEmail}
        onDevLogin={enterDevelopmentSession}
        onRecover={(email) => { setRecoveryEmail(email); setAuthView('recovery'); }}
      />;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;