import { useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  FileImage,
  FileOutput,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  UploadCloud,
  WandSparkles,
} from 'lucide-react';

export type QuickConvertOptions = {
  backgroundRemoval: boolean;
  seoNaming: boolean;
  svgOutput: boolean;
};

export type QuickConvertStage =
  | 'empty'
  | 'selected'
  | 'analyzing'
  | 'processing'
  | 'complete'
  | 'failed';

export interface QuickConvertPanelProps {
  file: File | null;
  options: QuickConvertOptions;
  stage: QuickConvertStage;
  statusMessage?: string | null;
  progress?: number | null;
  suggestedName?: string | null;
  originalPreviewUrl?: string | null;
  pngPreviewUrl?: string | null;
  svgPreviewUrl?: string | null;
  error?: string | null;
  regeneratingName: boolean;
  onFileChange(file: File | null): void;
  onOptionsChange(options: QuickConvertOptions): void;
  onConvert(): void;
  onRegenerateName(): void;
  onDownloadPng(): void;
  onDownloadSvg(): void;
  onReset(): void;
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const isImageFile = (file: File) => {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return ['image/png', 'image/jpeg', 'image/jpg'].includes(file.type) || extension === 'png' || extension === 'jpg' || extension === 'jpeg';
};

const getOptionDescription = (key: keyof QuickConvertOptions, enabled: boolean) => {
  const descriptions: Record<keyof QuickConvertOptions, [string, string]> = {
    backgroundRemoval: ['Transparent cutout PNG', 'Original background kept'],
    seoNaming: ['Content-aware filename', 'Original filename retained'],
    svgOutput: ['SVG for suitable artwork', 'PNG only'],
  };
  return descriptions[key][enabled ? 0 : 1];
};

function Checkerboard({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-[218px] items-center justify-center overflow-hidden rounded-[18px] border border-border bg-[linear-gradient(45deg,hsl(var(--muted))_25%,transparent_25%),linear-gradient(-45deg,hsl(var(--muted))_25%,transparent_25%),linear-gradient(45deg,transparent_75%,hsl(var(--muted))_75%),linear-gradient(-45deg,transparent_75%,hsl(var(--muted))_75%)] bg-[length:24px_24px] bg-[position:0_0,0_12px,12px_-12px,-12px_0px]">
      {children}
    </div>
  );
}

function OptionSwitch({
  label,
  description,
  checked,
  disabled,
  testId,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  testId: string;
  onChange(): void;
}) {
  return (
    <label className={`group flex items-center justify-between gap-4 rounded-[14px] border border-border bg-card px-4 py-3 transition-colors ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-primary/45 hover:bg-primary/[.025]'}`}>
      <span className="min-w-0">
        <span className="block text-[12px] font-extrabold tracking-[-.01em] text-foreground">{label}</span>
        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{description}</span>
      </span>
      <span className="relative shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          data-testid={testId}
          className="peer sr-only"
        />
        <span aria-hidden="true" className="block h-6 w-10 rounded-full border border-input bg-muted transition-colors peer-checked:border-primary peer-checked:bg-primary" />
        <span aria-hidden="true" className="pointer-events-none absolute left-1 top-1 size-4 rounded-full bg-card shadow-sm transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

function StageBadge({ stage }: { stage: QuickConvertStage }) {
  const copy: Record<QuickConvertStage, string> = {
    empty: 'Waiting for an image',
    selected: 'Ready to convert',
    analyzing: 'Analyzing image',
    processing: 'Converting asset',
    complete: 'Conversion complete',
    failed: 'Conversion needs attention',
  };
  const active = stage === 'analyzing' || stage === 'processing';
  const failed = stage === 'failed';
  return (
    <div
      data-testid="status-quick-stage"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-[.12em] ${
        failed
          ? 'border-destructive/25 bg-destructive/10 text-destructive'
          : active
            ? 'border-accent/35 bg-accent/10 text-accent-foreground'
            : stage === 'complete'
              ? 'border-primary/25 bg-primary/10 text-primary'
              : 'border-border bg-muted/70 text-muted-foreground'
      }`}
    >
      {active ? <Loader2 size={12} className="animate-spin" /> : failed ? <AlertTriangle size={12} /> : stage === 'complete' ? <CheckCircle2 size={12} /> : <span className="size-1.5 rounded-full bg-current" />}
      {copy[stage]}
    </div>
  );
}

function PreviewCard({
  label,
  fileName,
  src,
  emptyLabel,
  testId,
}: {
  label: string;
  fileName: string;
  src?: string | null;
  emptyLabel: string;
  testId: string;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
            <ImageIcon size={14} />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-extrabold text-foreground">{label}</p>
            <p className="truncate text-[10px] text-muted-foreground" title={fileName}>{fileName}</p>
          </div>
        </div>
        {src && <span className="mono rounded-md bg-primary/10 px-2 py-1 text-[9px] font-medium text-primary">PNG</span>}
      </div>
      <Checkerboard>
        {src ? (
          <img data-testid={testId} src={src} alt={`${label} preview`} className="max-h-[198px] max-w-[88%] object-contain drop-shadow-[0_14px_15px_hsl(var(--foreground)/.14)]" />
        ) : (
          <div data-testid={testId} className="flex flex-col items-center gap-2 px-8 text-center text-muted-foreground">
            <span className="flex size-11 items-center justify-center rounded-2xl border border-border bg-card/80"><FileImage size={20} /></span>
            <span className="text-[11px] font-semibold">{emptyLabel}</span>
          </div>
        )}
      </Checkerboard>
    </div>
  );
}

export function QuickConvertPanel({
  file,
  options,
  stage,
  statusMessage,
  progress,
  suggestedName,
  originalPreviewUrl,
  pngPreviewUrl,
  svgPreviewUrl,
  error,
  regeneratingName,
  onFileChange,
  onOptionsChange,
  onConvert,
  onRegenerateName,
  onDownloadPng,
  onDownloadSvg,
  onReset,
}: QuickConvertPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState('');
  const busy = stage === 'analyzing' || stage === 'processing';
  const optionsDisabled = stage !== 'empty' && stage !== 'selected';
  const hasOutput = stage === 'complete' || Boolean(pngPreviewUrl);
  const normalizedProgress = Math.max(0, Math.min(100, progress ?? (stage === 'complete' ? 100 : 0)));
  const displayName = suggestedName || file?.name || 'untitled-image';

  const chooseFile = (candidate: File | null) => {
    if (!candidate) return;
    if (!isImageFile(candidate)) {
      setFileError('Choose one PNG or JPG image to continue.');
      return;
    }
    setFileError('');
    onFileChange(candidate);
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    chooseFile(event.target.files?.[0] || null);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0] || null);
  };

  const updateOption = (key: keyof QuickConvertOptions) => {
    onOptionsChange({ ...options, [key]: !options[key] });
  };

  return (
    <section data-testid="quick-convert-panel" className="mx-auto w-full max-w-[1120px] animate-rise-in">
      <div className="relative overflow-hidden rounded-[26px] border border-card-border bg-card shadow-[0_18px_55px_hsl(var(--foreground)/.08)]">
        <div className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full bg-primary/[.07] blur-3xl" />
        <header className="relative flex flex-col gap-5 border-b border-border px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-[14px] bg-sidebar text-sidebar-primary shadow-sm">
              <WandSparkles size={20} strokeWidth={1.7} />
            </div>
            <div>
              <p className="mono text-[9px] font-medium uppercase tracking-[.2em] text-primary">quick convert</p>
              <h1 className="mt-1 text-[18px] font-extrabold tracking-[-.045em] text-foreground">One image. Production-ready.</h1>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <StageBadge stage={stage} />
            {stage !== 'empty' && (
              <button type="button" data-testid="button-quick-reset" onClick={onReset} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-bold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <RotateCcw size={13} /> Start over
              </button>
            )}
          </div>
        </header>

        <div className="relative grid gap-0 lg:grid-cols-[minmax(0,1fr)_310px]">
          <div className="min-w-0 p-5 sm:p-7">
            {(stage === 'empty' || stage === 'selected') && (
              <div className="animate-rise-in">
                <div
                  data-testid="dropzone-quick-file"
                  onDragEnter={() => setDragging(true)}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  className={`relative flex min-h-[252px] flex-col items-center justify-center overflow-hidden rounded-[20px] border-2 border-dashed px-6 text-center transition-colors ${
                    dragging ? 'border-primary bg-primary/[.07]' : file ? 'border-primary/45 bg-primary/[.025]' : 'border-border bg-background/55 hover:border-primary/50 hover:bg-primary/[.02]'
                  }`}
                >
                  <div className="pointer-events-none absolute inset-0 opacity-[.25] mesh-bg" />
                  {file ? (
                    <>
                      {originalPreviewUrl ? (
                        <div className="relative flex h-[150px] w-full max-w-[440px] items-center justify-center overflow-hidden rounded-xl border border-border bg-background/80 p-2 shadow-sm">
                          <img
                            data-testid="img-quick-selected-preview"
                            src={originalPreviewUrl}
                            alt={`Preview of ${file.name}`}
                            className="max-h-full max-w-full object-contain"
                          />
                          <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"><Check size={12} strokeWidth={3} /></span>
                        </div>
                      ) : (
                        <div className="relative flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                          <FileImage size={26} strokeWidth={1.6} />
                          <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check size={12} strokeWidth={3} /></span>
                        </div>
                      )}
                      <p data-testid="text-selected-file" className="relative mt-4 max-w-full truncate px-4 text-sm font-extrabold text-foreground">{file.name}</p>
                      <p className="relative mt-1 text-[11px] text-muted-foreground">{formatBytes(file.size)} · {file.type === 'image/png' ? 'PNG' : 'JPG'} source</p>
                      <button type="button" data-testid="button-replace-quick-file" onClick={() => inputRef.current?.click()} className="relative mt-5 inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-[11px] font-extrabold text-foreground transition-colors hover:border-primary/50 hover:text-primary">
                        <RefreshCw size={13} /> Replace image
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="relative flex size-14 items-center justify-center rounded-2xl bg-secondary text-primary shadow-sm"><UploadCloud size={27} strokeWidth={1.6} /></div>
                      <h2 className="relative mt-5 text-lg font-extrabold tracking-[-.035em] text-foreground">{dragging ? 'Release to add image' : 'Drop one image here'}</h2>
                      <p className="relative mt-2 max-w-sm text-[11px] leading-5 text-muted-foreground">Use a PNG or JPG. Your original stays available for comparison.</p>
                      <button type="button" data-testid="button-choose-quick-file" onClick={() => inputRef.current?.click()} className="relative mt-5 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-[11px] font-extrabold text-primary-foreground shadow-sm transition-opacity hover:opacity-90">
                        <UploadCloud size={15} /> Choose image
                      </button>
                    </>
                  )}
                  <input ref={inputRef} data-testid="input-quick-file" type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" onChange={handleInput} className="hidden" />
                </div>
                {fileError && <div data-testid="status-quick-file-error" role="alert" className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-[11px] font-semibold text-destructive"><AlertTriangle size={14} />{fileError}</div>}

                <div className="mt-6 flex flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-[11px] font-bold text-muted-foreground">Ready when you are</p>
                    <p className="mt-1 text-[10px] text-muted-foreground/75">Review your output before downloading.</p>
                  </div>
                  <button type="button" data-testid="button-start-quick-convert" disabled={!file || busy} onClick={onConvert} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-[12px] font-extrabold text-primary-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0">
                    <Sparkles size={15} /> Convert image <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            )}

            {busy && (
              <div data-testid={`status-quick-${stage}`} role="status" className="animate-rise-in py-8 sm:py-12">
                <div className="mx-auto flex max-w-md flex-col items-center text-center">
                  <div className="relative flex size-20 items-center justify-center rounded-[26px] border border-primary/25 bg-primary/10 text-primary">
                    <div className="absolute inset-2 rounded-[19px] border border-primary/25 progress-line" />
                    {stage === 'analyzing' ? <ImageIcon size={29} strokeWidth={1.5} /> : <WandSparkles size={29} strokeWidth={1.5} />}
                  </div>
                  <p className="mono mt-7 text-[9px] uppercase tracking-[.2em] text-primary">{stage === 'analyzing' ? 'analysis pass' : 'production pass'}</p>
                  <h2 className="mt-3 text-3xl font-extrabold tracking-[-.06em] text-foreground">{stage === 'analyzing' ? 'Reading the image.' : 'Making the asset ready.'}</h2>
                  <p data-testid="status-quick-message" className="mt-3 max-w-sm text-[12px] leading-5 text-muted-foreground">{statusMessage || (stage === 'analyzing' ? 'Identifying the subject and preparing your conversion.' : 'Applying your settings and preparing downloadable files.')}</p>
                  <div className="mt-8 w-full rounded-2xl border border-card-border bg-card p-4 text-left shadow-sm">
                    <div className="mb-2 flex items-center justify-between text-[11px]"><span className="truncate pr-4 font-bold text-foreground">{file?.name || 'Selected image'}</span><span data-testid="text-quick-progress" className="mono text-primary">{Math.round(normalizedProgress)}%</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(normalizedProgress, 3)}%` }} /></div>
                  </div>
                </div>
              </div>
            )}

            {stage === 'failed' && (
              <div data-testid="status-quick-failed" role="alert" className="animate-rise-in py-6">
                <div className="rounded-[20px] border border-destructive/25 bg-destructive/[.05] p-5 sm:p-6">
                  <div className="flex items-start gap-4">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive"><AlertTriangle size={22} /></span>
                    <div className="min-w-0">
                      <p className="mono text-[9px] uppercase tracking-[.18em] text-destructive">conversion interrupted</p>
                      <h2 className="mt-2 text-xl font-extrabold tracking-[-.04em] text-foreground">We could not finish this image.</h2>
                      <p data-testid="status-quick-error" className="mt-2 text-[12px] leading-5 text-muted-foreground">{error || statusMessage || 'Something went wrong while preparing the asset. Try again or choose a different image.'}</p>
                    </div>
                  </div>
                  <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                    <button type="button" data-testid="button-retry-quick-convert" onClick={onConvert} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[11px] font-extrabold text-primary-foreground transition-opacity hover:opacity-90"><RefreshCw size={14} /> Try again</button>
                    <button type="button" data-testid="button-reset-after-error" onClick={onReset} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-[11px] font-extrabold text-foreground transition-colors hover:border-primary/40 hover:text-primary"><RotateCcw size={14} /> Choose another image</button>
                  </div>
                </div>
              </div>
            )}

            {stage === 'complete' && (
              <div data-testid="status-quick-complete" className="animate-rise-in">
                <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="mono text-[9px] uppercase tracking-[.2em] text-primary">output check</p>
                    <h2 className="mt-2 text-3xl font-extrabold tracking-[-.065em] text-foreground">Looks ready to ship.</h2>
                    <p data-testid="status-quick-complete-message" className="mt-2 text-[12px] text-muted-foreground">{statusMessage || 'Compare the source and processed PNG, then download what you need.'}</p>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-primary"><CheckCircle2 size={15} /> Finished in this workspace</div>
                </div>
                <div className="grid gap-5 md:grid-cols-2">
                  <PreviewCard label="Original" fileName={file?.name || 'source image'} src={originalPreviewUrl} emptyLabel="Original preview unavailable" testId="img-quick-original-preview" />
                  <PreviewCard label="Processed PNG" fileName={displayName.replace(/\.(png|jpg|jpeg)$/i, '') + '.png'} src={pngPreviewUrl} emptyLabel="PNG preview unavailable" testId="img-quick-png-preview" />
                </div>
                <div className="mt-5 rounded-2xl border border-border bg-muted/35 p-4 sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">Suggested filename</p>
                      <p data-testid="text-quick-suggested-name" className="mt-1 truncate text-sm font-extrabold text-foreground" title={displayName}>{displayName}</p>
                      {options.seoNaming && (
                        <button
                          type="button"
                          data-testid="button-regenerate-quick-name"
                          disabled={regeneratingName}
                          onClick={onRegenerateName}
                          className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold text-primary transition-colors hover:bg-primary/10 disabled:cursor-wait disabled:opacity-60"
                        >
                          {regeneratingName ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                          {regeneratingName ? 'Finding another name…' : 'Regenerate name'}
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" data-testid="button-download-quick-png" disabled={!pngPreviewUrl && !hasOutput} onClick={onDownloadPng} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3.5 text-[11px] font-extrabold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"><ArrowDownToLine size={14} /> Download PNG</button>
                      {options.svgOutput && svgPreviewUrl && <button type="button" data-testid="button-download-quick-svg" onClick={onDownloadSvg} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[11px] font-extrabold text-foreground transition-colors hover:border-primary/40 hover:text-primary"><FileOutput size={14} /> Download SVG</button>}
                    </div>
                  </div>
                </div>
                {options.svgOutput && (
                  <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-card">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                      <div><p className="text-[11px] font-extrabold text-foreground">Companion SVG</p><p className="mt-0.5 text-[10px] text-muted-foreground">Optional vector output from this conversion.</p></div>
                      {svgPreviewUrl && <span className="mono rounded-md bg-accent/15 px-2 py-1 text-[9px] text-accent-foreground">SVG READY</span>}
                    </div>
                    <div className="p-4">
                      {svgPreviewUrl ? <Checkerboard><img data-testid="img-quick-svg-preview" src={svgPreviewUrl} alt="SVG preview" className="max-h-[180px] max-w-[82%] object-contain" /></Checkerboard> : <div data-testid="status-quick-svg-unavailable" className="flex min-h-[108px] items-center justify-center rounded-[14px] bg-muted/45 text-[11px] text-muted-foreground">SVG output was not returned for this image.</div>}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <aside className="border-t border-border bg-muted/[.24] p-5 sm:p-7 lg:border-l lg:border-t-0">
            <div className="flex items-center justify-between">
              <div><p className="mono text-[9px] uppercase tracking-[.18em] text-primary">conversion recipe</p><h2 className="mt-1 text-[15px] font-extrabold tracking-[-.03em]">Output settings</h2></div>
              <ChevronDown size={15} className="text-muted-foreground lg:hidden" />
            </div>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">Choose the work your image needs. You can change these before starting.</p>
            <div className="mt-5 space-y-2.5">
              <OptionSwitch label="Remove background" description={getOptionDescription('backgroundRemoval', options.backgroundRemoval)} checked={options.backgroundRemoval} disabled={optionsDisabled} testId="checkbox-quick-background-removal" onChange={() => updateOption('backgroundRemoval')} />
              <OptionSwitch label="SEO filename" description={getOptionDescription('seoNaming', options.seoNaming)} checked={options.seoNaming} disabled={optionsDisabled} testId="checkbox-quick-seo-naming" onChange={() => updateOption('seoNaming')} />
              <OptionSwitch label="Create SVG" description={getOptionDescription('svgOutput', options.svgOutput)} checked={options.svgOutput} disabled={optionsDisabled} testId="checkbox-quick-svg-output" onChange={() => updateOption('svgOutput')} />
            </div>
            <div className="mt-6 border-t border-border pt-5">
              <p className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">Included in this pass</p>
              <ul className="mt-3 space-y-2.5">
                <li className="flex items-center gap-2 text-[11px] text-muted-foreground"><span className="flex size-4 items-center justify-center rounded-full bg-primary/15 text-primary"><Check size={10} strokeWidth={3} /></span> Original stays untouched</li>
                <li className="flex items-center gap-2 text-[11px] text-muted-foreground"><span className="flex size-4 items-center justify-center rounded-full bg-primary/15 text-primary"><Check size={10} strokeWidth={3} /></span> Side-by-side output check</li>
                <li className="flex items-center gap-2 text-[11px] text-muted-foreground"><span className="flex size-4 items-center justify-center rounded-full bg-primary/15 text-primary"><Check size={10} strokeWidth={3} /></span> Download only what you need</li>
              </ul>
            </div>
            {file && (
              <div className="mt-6 rounded-xl border border-border bg-card p-3.5">
                <div className="flex items-center gap-2"><FileImage size={14} className="text-primary" /><span className="truncate text-[10px] font-bold text-foreground">{file.name}</span></div>
                <p className="mono mt-2 text-[9px] text-muted-foreground">{formatBytes(file.size)} / source file</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}

export default QuickConvertPanel;