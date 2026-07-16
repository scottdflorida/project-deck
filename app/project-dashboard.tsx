"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFailureResponse, ActionResponse, ProjectRecord, ProjectScanResponse, SyncState } from "@/lib/project-types";
import { attentionReason, compareProjects, needsAttention, projectInView, type ProjectView, type SortDirection, type SortKey } from "@/lib/project-ledger";
import { formatProjectSize } from "@/lib/format-project-size";
import { AlertCircle, ArrowDown, ArrowUp, Check, CircleDot, Copy, ExternalLink, Folder, GitBranch, Github, LoaderCircle, Lock, MoreHorizontal, Pencil, RefreshCw, Search, Unlock, X } from "@/app/icons";

const API_BASE = "";
const RETRY_MS = 4_000;
const viewLabels: Record<ProjectView, string> = { working: "Working set", attention: "Needs attention", local: "Local only", ignored: "Ignored" };
const sortLabels: Record<SortKey, string> = { name: "Name", size: "Size", git: "Git", github: "GitHub", sync: "Sync" };
type GithubAuthState = { checked: boolean; cliAvailable: boolean; connected: boolean; login: string | null };
type ProjectActionKind = "init" | "link" | "create-repo" | "push" | "preferences";
type RepoModal = { type: "create" | "link" | "push"; project: ProjectRecord; trigger: HTMLElement | null };
type PreferenceModal = { type: "preference"; kind: "ignored" | "localOnly"; project: ProjectRecord; trigger: HTMLElement | null };
type DescriptionModal = { type: "description"; project: ProjectRecord; trigger: HTMLElement | null };
type ModalState = RepoModal | PreferenceModal | DescriptionModal | null;
type ProjectActionFailure = { projectPath: string; projectName: string; kind: ProjectActionKind; label: string; message: string; code?: string };
const actionLabels: Record<ProjectActionKind, string> = { init: "Initialize Git", link: "Link repository", "create-repo": "Create GitHub repository", push: "Publish to GitHub", preferences: "Update project preference" };

function syncView(state: SyncState, ahead: number, behind: number) {
  if (state === "in_sync") return { label: "In sync", tone: "good", Icon: Check };
  if (state === "ahead") return { label: `${ahead} ahead`, tone: "warn", Icon: ArrowUp };
  if (state === "behind") return { label: `${behind} behind`, tone: "bad", Icon: ArrowDown };
  if (state === "diverged") return { label: `${ahead} ahead · ${behind} behind`, tone: "bad", Icon: AlertCircle };
  if (state === "unpublished") return { label: "Not pushed", tone: "warn", Icon: ArrowUp };
  if (state === "no_commits") return { label: "No commits", tone: "neutral", Icon: CircleDot };
  if (state === "no_remote") return { label: "No remote", tone: "neutral", Icon: Github };
  return { label: "Unavailable", tone: "unavailable", Icon: AlertCircle };
}

function gitView(project: ProjectRecord) {
  if (!project.git.isRepository) return { label: "Not initialized", detail: "Local folder", tone: "neutral" };
  if (!project.git.hasCommits) return { label: "Repository, no commits", detail: project.git.branch || "No branch yet", tone: "warn" };
  if (!project.git.statusAvailable) return { label: "Status unavailable", detail: project.git.branch || "Repository", tone: "unavailable" };
  if (project.git.changeCount) return { label: `${project.git.changeCount} local ${project.git.changeCount === 1 ? "change" : "changes"}`, detail: project.git.branch || "Detached HEAD", tone: "warn" };
  return { label: "Repository, clean", detail: project.git.branch || "Detached HEAD", tone: "good" };
}

function githubView(project: ProjectRecord) {
  if (project.github.state === "linked") return { label: "Linked", detail: project.github.repository?.nameWithOwner || "GitHub remote", tone: "good" };
  if (project.github.state === "matched") return { label: "Match found", detail: project.github.repository?.nameWithOwner || "Ready to link", tone: "warn" };
  if (project.github.state === "unavailable") return { label: "Unavailable", detail: "GitHub check unavailable", tone: "unavailable" };
  if (project.preferences.localOnly) return { label: "Not planned", detail: "Local only", tone: "neutral" };
  return { label: "No repository", detail: "Nothing linked", tone: "neutral" };
}

function latestUpdate(project: ProjectRecord) {
  const value = project.git.lastCommitAt || project.modifiedAt;
  if (!value) return { relative: "Unavailable", exact: "Latest update unavailable" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { relative: "Unavailable", exact: "Latest update unavailable" };
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  const relative = days === 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days} days ago` : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  return { relative, exact: date.toLocaleString() };
}

function useDialogFocus(ref: React.RefObject<HTMLElement | null>, busy: boolean, onClose: () => void) {
  useEffect(() => {
    const node = ref.current;
    node?.querySelector<HTMLElement>("[data-dialog-initial],textarea,input,button:not([disabled])")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab" || !node) return;
      const controls = [...node.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href]')];
      if (!controls.length) return;
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0].focus(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, onClose, ref]);
}

function DialogFrame({ children, titleId, busy, onClose, className = "" }: { children: React.ReactNode; titleId: string; busy: boolean; onClose: () => void; className?: string }) {
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, busy, onClose);
  return <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
    <section ref={dialog} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
      <button className="icon-button dialog-close" onClick={onClose} disabled={busy} aria-label="Close dialog"><X size={18}/></button>
      {children}
    </section>
  </div>;
}

function RepoActionModal({ modal, busy, error, onClose, onSubmit }: { modal: RepoModal; busy: boolean; error: ProjectActionFailure | null; onClose: () => void; onSubmit: (payload: Record<string, string>) => void }) {
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [message, setMessage] = useState(modal.project.git.hasCommits ? "Update project" : "Initial commit");
  const submit = useRef<HTMLButtonElement>(null); const wasBusy = useRef(false);
  useEffect(() => { if (wasBusy.current && !busy && error) submit.current?.focus(); wasBusy.current = busy; }, [busy, error]);
  const create = modal.type === "create";
  const link = modal.type === "link";
  const emptyInitial = !modal.project.git.hasCommits && modal.project.git.changeCount === 0;
  const title = create ? "Create a GitHub repository" : link ? modal.project.git.isRepository ? "Link repository" : "Initialize & link" : emptyInitial ? "Create initial commit & push" : modal.project.git.changeCount ? "Commit & push" : "Push to GitHub";
  const matchedRepository = modal.project.github.repository?.nameWithOwner || "the matched GitHub repository";
  const consequence = create
    ? modal.project.git.isRepository
      ? "This creates the GitHub repository and adds origin. It does not change files or commits and does not push."
      : "This initializes local Git, creates the GitHub repository, and adds origin. It does not create a commit or push files; publishing remains a separate action."
    : link
      ? modal.project.git.isRepository
        ? `This adds ${matchedRepository} as origin. It does not change project files or commits.`
        : `This initializes local Git and adds ${matchedRepository} as origin. It does not change project files or create commits.`
      : emptyInitial
        ? "This project has no commits or file changes. Project Deck may create an empty initial commit, then push it to the linked GitHub repository."
        : !modal.project.git.hasCommits
          ? `This creates the project’s initial commit from the current changes on ${modal.project.git.branch || "the current branch"}, then pushes it to ${modal.project.github.repository?.nameWithOwner || "GitHub"}.`
          : modal.project.git.changeCount
            ? `This stages eligible changes, creates a commit on ${modal.project.git.branch || "the current branch"}, and pushes it to ${modal.project.github.repository?.nameWithOwner || "GitHub"}.`
            : `This publishes ${modal.project.git.branch || "the current branch"} to ${modal.project.github.repository?.nameWithOwner || "GitHub"}.`;
  return <DialogFrame titleId="repo-dialog-title" busy={busy} onClose={onClose}>
    <p className="kicker">REPOSITORY ACTION · {modal.project.name}</p><h2 id="repo-dialog-title">{title}</h2>
    <p>{consequence}</p>
    {create ? <div className="choice-grid" role="radiogroup" aria-label="Repository visibility">{(["private", "public"] as const).map((value) => <button key={value} data-dialog-initial={value === "private" ? "true" : undefined} role="radio" aria-checked={visibility === value} className={visibility === value ? "selected" : ""} onClick={() => setVisibility(value)}>{value === "private" ? <Lock size={17}/> : <Unlock size={17}/>}<span><strong>{value === "private" ? "Private" : "Public"}</strong><small>{value === "private" ? "Only invited people" : "Visible to everyone"}</small></span>{visibility === value && <Check size={17}/>}</button>)}</div>
      : !link && (modal.project.git.changeCount > 0 || !modal.project.git.hasCommits) && <label className="field"><span>Commit message</span><input data-dialog-initial="true" value={message} maxLength={120} onChange={(event) => setMessage(event.target.value)} /><small>Obvious untracked secret files are blocked before staging.</small></label>}
    {error && error.projectPath === modal.project.canonicalPath && <div className="action-dialog-error" role="alert"><strong>{error.label} failed for {error.projectName}</strong><span>{error.message}</span></div>}
    <div className="dialog-actions"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button ref={submit} data-dialog-initial={link ? "true" : undefined} className="button primary" disabled={busy || (!create && !link && (modal.project.git.changeCount > 0 || !modal.project.git.hasCommits) && !message.trim())} onClick={() => onSubmit(create ? { visibility } : link ? {} : { message })}>{busy ? <LoaderCircle className="spin" size={15}/> : create || link ? <Github size={15}/> : <ArrowUp size={15}/>} {busy ? "Working…" : title}</button></div>
  </DialogFrame>;
}

function PreferenceDialog({ modal, busy, error, onClose, onConfirm }: { modal: PreferenceModal; busy: boolean; error: ProjectActionFailure | null; onClose: () => void; onConfirm: () => void }) {
  const isIgnore = modal.kind === "ignored";
  const active = modal.project.preferences[modal.kind];
  const title = isIgnore ? active ? "Restore to working set" : "Ignore project" : active ? "Allow GitHub" : "Keep local only";
  const copy = isIgnore
    ? active ? "This returns the project to the working set. Nothing in its folder will change." : "This hides the project from normal working-set views. It remains on disk, scanned, searchable in Ignored, and can be restored."
    : active ? "GitHub publishing prompts and remote attention will return. No repository action will run until you choose one." : modal.project.github.state === "linked"
      ? "This keeps the existing GitHub repository and remote unchanged. Project Deck will stop suggesting GitHub publishing and ignore remote sync when deciding whether this project needs attention."
      : "Project Deck will stop suggesting GitHub publishing. Local Git remains available and no repository action will run.";
  return <DialogFrame titleId="preference-title" busy={busy} onClose={onClose}><p className="kicker">PROJECT INTENT · {modal.project.name}</p><h2 id="preference-title">{title}</h2><p>{copy}</p>{error?.projectPath === modal.project.canonicalPath && <div className="action-dialog-error" role="alert"><strong>{error.label} failed for {error.projectName}</strong><span>{error.message}</span></div>}<div className="dialog-actions"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button data-dialog-initial="true" className="button primary" onClick={onConfirm} disabled={busy}>{busy && <LoaderCircle className="spin" size={15}/>} {title}</button></div></DialogFrame>;
}

function DescriptionDialog({ modal, busy, error, onClose, onSave, onClear }: { modal: DescriptionModal; busy: boolean; error: ProjectActionFailure | null; onClose: () => void; onSave: (description: string) => void; onClear: () => void }) {
  const [value, setValue] = useState(modal.project.description.source === "local" ? modal.project.description.text : "");
  return <DialogFrame titleId="description-title" busy={busy} onClose={onClose}><p className="kicker">LOCAL NOTE · {modal.project.name}</p><h2 id="description-title">Edit local description</h2><p>This note is stored in Project Deck for this absolute folder path. It never edits README, manifests, or Git.</p><label className="field"><span>Project description</span><textarea data-dialog-initial="true" rows={6} maxLength={2000} value={value} onChange={(event) => setValue(event.target.value)} placeholder={modal.project.description.text || "What is this project for?"}/><small>{value.length} / 2000</small></label>{error?.projectPath === modal.project.canonicalPath && <div className="action-dialog-error" role="alert"><strong>{error.label} failed for {error.projectName}</strong><span>{error.message}</span></div>}<div className="dialog-actions split">{modal.project.description.source === "local" ? <button className="button quiet danger" onClick={onClear} disabled={busy}>Clear local description</button> : <span/>}<button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={() => onSave(value)} disabled={busy || !value.trim()}>{busy && <LoaderCircle className="spin" size={15}/>} Save description</button></div></DialogFrame>;
}

function ProjectActions({ project, githubAvailable, busy, enriching, onAction, onModal }: { project: ProjectRecord; githubAvailable: boolean; busy: boolean; enriching: boolean; onAction: (kind: "init", trigger: HTMLElement) => void; onModal: (modal: RepoModal) => void }) {
  if (enriching) return <span className="action-guidance"><LoaderCircle className="spin" size={14}/> Checking actions…</span>;
  if (project.preferences.localOnly) return !project.git.isRepository
    ? <div className="local-init"><button className="button primary" disabled={busy} onClick={(event) => onAction("init", event.currentTarget)}><GitBranch size={15}/> Initialize Git</button><small>Creates local .git only</small></div>
    : <span className="action-guidance"><Check size={14}/> Local only</span>;
  if (!project.git.isRepository) return <>{project.github.state === "matched"
    ? <button className="button primary" disabled={busy} onClick={(event) => onModal({ type: "link", project, trigger: event.currentTarget })}><Github size={15}/> Initialize & link</button>
    : <div className="local-init"><button className="button primary" disabled={busy} onClick={(event) => onAction("init", event.currentTarget)}><GitBranch size={15}/> Initialize Git</button><small>Creates local .git only</small></div>}
    {project.github.state === "none" && githubAvailable && <button className="button secondary" disabled={busy} onClick={(event) => onModal({ type: "create", project, trigger: event.currentTarget })}><Github size={15}/> Create GitHub repository</button>}</>;
  if (project.github.state === "matched") return <button className="button primary" disabled={busy} onClick={(event) => onModal({ type: "link", project, trigger: event.currentTarget })}><Github size={15}/> Link repository</button>;
  if (project.github.state === "none" && githubAvailable) return <button className="button primary" disabled={busy} onClick={(event) => onModal({ type: "create", project, trigger: event.currentTarget })}><Github size={15}/> Create GitHub repository</button>;
  if (project.github.state === "linked") {
    if (["behind", "diverged"].includes(project.sync.state)) return <span className="action-guidance caution">Reconcile outside Project Deck, then refresh</span>;
    if (project.sync.state === "unavailable") return <span className="action-guidance">Remote status unavailable</span>;
    if (!project.git.hasCommits || project.git.changeCount > 0 || ["ahead", "unpublished"].includes(project.sync.state)) {
      const label = !project.git.hasCommits ? project.git.changeCount ? "Commit & push" : "Create initial commit & push" : project.git.changeCount ? "Commit & push" : "Push to GitHub";
      return <button className="button primary" disabled={busy} onClick={(event) => onModal({ type: "push", project, trigger: event.currentTarget })}><ArrowUp size={15}/> {label}</button>;
    }
    if (project.sync.state === "in_sync") return <span className="action-guidance good"><Check size={14}/> Up to date</span>;
  }
  return <span className="action-guidance">No repository action available</span>;
}

function ProjectRow({ project, githubAvailable, busy, enriching, actionError, onAction, onCopy, onModal, onDismissActionError }: { project: ProjectRecord; githubAvailable: boolean; busy: boolean; enriching: boolean; actionError: ProjectActionFailure | null; onAction: (project: ProjectRecord, kind: "init", trigger: HTMLElement) => void; onCopy: (project: ProjectRecord) => void; onModal: (modal: NonNullable<ModalState>) => void; onDismissActionError: () => void }) {
  const git = gitView(project); const github = githubView(project); const sync = syncView(project.sync.state, project.sync.ahead, project.sync.behind); const update = latestUpdate(project);
  const descriptionMissing = project.description.source === "none";
  return <li className="project-row" data-project={project.name} data-project-path={project.canonicalPath}>
    <article className="project-record" aria-labelledby={`project-${encodeURIComponent(project.canonicalPath)}`}>
      <div className="project-identity">
        <div className="identity-heading"><span className="project-index" aria-hidden="true">{project.name.slice(0, 2).toUpperCase()}</span><div><h2 id={`project-${encodeURIComponent(project.canonicalPath)}`}>{project.name}</h2><div className="intent-list">{project.preferences.localOnly && <span>Local only</span>}{project.preferences.ignored && <span>Ignored</span>}{needsAttention(project) && !project.preferences.ignored && <span className="attention-intent">Needs attention</span>}</div></div><details className="project-menu" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.removeAttribute("open"); event.currentTarget.querySelector<HTMLElement>("summary")?.focus(); } }}><summary role="button" aria-label={`Project menu for ${project.name}`}><MoreHorizontal size={18}/></summary><div role="menu"><button role="menuitem" onClick={(event) => onModal({ type: "description", project, trigger: event.currentTarget })}><Pencil size={14}/> {descriptionMissing ? "Add local description" : "Edit local description"}</button><button role="menuitem" onClick={(event) => onModal({ type: "preference", kind: "localOnly", project, trigger: event.currentTarget })}>{project.preferences.localOnly ? "Allow GitHub" : "Keep local only"}</button><button role="menuitem" onClick={(event) => onModal({ type: "preference", kind: "ignored", project, trigger: event.currentTarget })}>{project.preferences.ignored ? "Restore to working set" : "Ignore project"}</button></div></details></div>
        <div className={`description ${descriptionMissing ? "missing" : ""}`}>{project.description.source === "checking" ? <p>Checking local description…</p> : descriptionMissing ? <><p>No suitable local description found</p><button onClick={(event) => onModal({ type: "description", project, trigger: event.currentTarget })}>Add local description</button></> : <><p aria-label={project.description.text}>{project.description.compact}</p><span>{project.description.sourceLabel}</span></>}</div>
        <div className="path-line"><span>Folder path</span><code>{project.canonicalPath}</code><button onClick={() => onCopy(project)} aria-label={`Copy absolute folder path for ${project.name}`}><Copy size={13}/> Copy folder path</button></div>
      </div>
      <div className="project-facts"><div><span>Total size</span><strong>{project.size.status === "complete" ? formatProjectSize(project.size.bytes) : "Unavailable"}</strong></div><div><span>Latest update:</span><time dateTime={project.git.lastCommitAt || project.modifiedAt || undefined} title={update.exact} aria-label={`Latest update: ${update.relative}. Exact time: ${update.exact}`}>{update.relative}<span className="sr-only"> · {update.exact}</span></time></div>{project.technologies.length > 0 && <div className="technology-list" aria-label="Technologies">{project.technologies.join(" · ")}</div>}{needsAttention(project) && <p className="attention-reason">{attentionReason(project)}</p>}</div>
      <div className="repository-rail" aria-label={`Repository state for ${project.name}`}>
        <div className={`rail-stop ${git.tone}`}><span><GitBranch size={14}/> Git</span><strong>{git.label}</strong><small>{git.detail}</small></div>
        <div className={`rail-stop ${github.tone}`}><span><Github size={14}/> GitHub</span><strong>{github.label}</strong><small>{github.detail}</small></div>
        <div className={`rail-stop ${sync.tone}`}><span><sync.Icon size={14}/> Sync</span><strong>{project.preferences.localOnly && project.github.state !== "linked" ? "Not planned" : sync.label}</strong><small>{project.preferences.localOnly && project.github.state !== "linked" ? "Local only" : project.sync.detail}</small></div>
      </div>
      <div className="record-actions" aria-label={`Actions for ${project.name}`}>{actionError?.projectPath === project.canonicalPath && <div className="project-action-error" role="alert"><strong>{actionError.label} failed for {project.name}</strong><p>{actionError.message}</p><button onClick={onDismissActionError}>Dismiss</button></div>}<div className="primary-action"><ProjectActions project={project} githubAvailable={githubAvailable} busy={busy} enriching={enriching} onAction={(kind, trigger) => onAction(project, kind, trigger)} onModal={onModal}/></div><div className="record-utilities">{project.github.state === "linked" && project.github.repository && <a href={project.github.repository.url} target="_blank" rel="noreferrer">Open on GitHub <ExternalLink size={13}/></a>}<details><summary>Sync details</summary><p>{project.sync.detail}</p></details></div></div>
    </article>
  </li>;
}

function Skeleton() { return <li className="project-row skeleton" aria-hidden="true"><div className="sk sk-wide"/><div className="sk"/><div className="sk sk-rail"/><div className="sk"/></li>; }

function RootPicker({ value, busy, error, onChange, onClose, onBrowse, onSave }: { value: string; busy: boolean; error: string | null; onChange: (value: string) => void; onClose: () => void; onBrowse: () => void; onSave: () => void }) {
  return <DialogFrame titleId="root-picker-title" busy={busy} onClose={onClose} className="root-picker"><p className="kicker">PROJECT SOURCE</p><h2 id="root-picker-title">Choose a parent folder</h2><p>Each direct child folder becomes one project. This root and project preferences stay on this computer.</p><label className="field"><span>Folder path</span><input value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && value.trim() && !busy) onSave(); }} placeholder="~/Documents"/><small>Use an absolute path or a path beginning with ~/.</small></label>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions split"><button className="button quiet" onClick={onBrowse} disabled={busy}><Folder size={15}/> Browse…</button><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={onSave} disabled={busy || !value.trim()}>{busy ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>} Use this folder</button></div></DialogFrame>;
}

function Onboarding({ rootLabel, auth, authCode, busy, error, onChooseFolder, onConnect, onDone }: { rootLabel: string; auth: GithubAuthState; authCode: string | null; busy: boolean; error: string | null; onChooseFolder: () => void; onConnect: () => void; onDone: () => void }) {
  const dialog = useRef<HTMLElement>(null); const stayOpen = useCallback(() => {}, []); useDialogFocus(dialog, busy, stayOpen);
  return <div className="modal-backdrop onboarding-backdrop"><section ref={dialog} className="dialog onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><p className="kicker">WELCOME · LOCAL BY DESIGN</p><h2 id="onboarding-title">Build your working set.</h2><p>Project Deck stays on this computer. It inventories folders and reads descriptions from local README and project metadata; you can edit a private local description at any time.</p><div className="onboarding-steps"><section><span>01</span><div><strong>Choose the parent folder</strong><code>{rootLabel}</code><small>Every direct child folder becomes one project.</small></div><button className="button secondary" onClick={onChooseFolder}>Change folder</button></section><section><span>02</span><div><strong>GitHub is optional</strong>{!auth.checked ? <small>Checking GitHub availability…</small> : auth.connected ? <small className="success-copy">Connected as @{auth.login}. Remote status is available.</small> : authCode ? <><code className="device-code">{authCode}</code><small>Enter this one-time code on GitHub.</small></> : <small>Local scanning, sorting, Git, intent, and descriptions work without it.</small>}</div>{auth.checked && !auth.connected && auth.cliAvailable && (authCode ? <a className="button primary" href="https://github.com/login/device" target="_blank" rel="noreferrer">Open GitHub <ExternalLink size={14}/></a> : <button className="button secondary" onClick={onConnect} disabled={busy}><Github size={15}/> Connect GitHub</button>)}</section></div>{error && <p className="inline-error" role="alert">{error}</p>}<div className="onboarding-footer"><button className="button primary" onClick={onDone}>{auth.connected ? "Open working set" : "Continue without GitHub"}</button></div></section></div>;
}

export function ProjectDashboard() {
  const [data, setData] = useState<ProjectScanResponse | null>(null); const [scannerError, setScannerError] = useState<string | null>(null); const [actionError, setActionError] = useState<ProjectActionFailure | null>(null); const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState(""); const [view, setView] = useState<ProjectView>("working"); const [sortKey, setSortKey] = useState<SortKey>("name"); const [sortDirection, setSortDirection] = useState<SortDirection>("asc"); const [lensReady, setLensReady] = useState(false);
  const [busyProject, setBusyProject] = useState<string | null>(null); const [modal, setModal] = useState<ModalState>(null); const [toast, setToast] = useState<string | null>(null); const [copyError, setCopyError] = useState<string | null>(null); const [retryPending, setRetryPending] = useState(false); const [retryExhausted, setRetryExhausted] = useState(false);
  const [rootPickerOpen, setRootPickerOpen] = useState(false); const [rootDraft, setRootDraft] = useState("~/Documents"); const [rootBusy, setRootBusy] = useState(false); const [rootError, setRootError] = useState<string | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false); const [githubAuth, setGithubAuth] = useState<GithubAuthState>({ checked: false, cliAvailable: false, connected: false, login: null }); const [authCode, setAuthCode] = useState<string | null>(null); const [authBusy, setAuthBusy] = useState(false); const [authError, setAuthError] = useState<string | null>(null);
  const retryTimer = useRef<number | null>(null); const requestActive = useRef(false); const queuedLoad = useRef<{ refresh: boolean; manual: boolean } | null>(null); const outageAttempts = useRef(0); const dataRef = useRef<ProjectScanResponse | null>(null); const lensInteracted = useRef(false); const loadRef = useRef<(refresh?: boolean, manual?: boolean) => Promise<void>>(async () => {});
  const refreshGithubAuth = useCallback(async () => { try { const response = await fetch(`${API_BASE}/api/github/auth`, { cache: "no-store" }); const result = await response.json() as Omit<GithubAuthState, "checked">; setGithubAuth({ checked: true, ...result }); } catch { setGithubAuth({ checked: true, cliAvailable: false, connected: false, login: null }); } }, []);
  const loadProjects = useCallback(async (refresh = false, manual = false) => { if (requestActive.current) { if (manual) queuedLoad.current = { refresh, manual }; return; } if (manual) { outageAttempts.current = 0; if (retryTimer.current) window.clearTimeout(retryTimer.current); setRetryPending(false); setRetryExhausted(false); } requestActive.current = true; if (refresh) setRefreshing(true); else setLoading(true); setScannerError(null); try { const response = await fetch(`${API_BASE}/api/projects${refresh ? "?refresh=remote" : ""}`, { cache: "no-store" }); if (!response.ok) throw new Error(); const result = await response.json() as ProjectScanResponse; dataRef.current = result; setData(result); outageAttempts.current = 0; setRetryExhausted(false); } catch { setScannerError("The local scanner is unavailable."); if (!dataRef.current) { outageAttempts.current += 1; if (outageAttempts.current === 1) { setRetryPending(true); retryTimer.current = window.setTimeout(() => { setRetryPending(false); void loadRef.current(false); }, RETRY_MS); } else setRetryExhausted(true); } } finally { requestActive.current = false; setLoading(false); setRefreshing(false); const queued = queuedLoad.current; queuedLoad.current = null; if (queued) window.setTimeout(() => void loadRef.current(queued.refresh, queued.manual), 0); } }, []);
  useEffect(() => { loadRef.current = loadProjects; }, [loadProjects]);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { const initial = window.setTimeout(() => { try { const lens = JSON.parse(window.localStorage.getItem("project-deck-lens-v1") || "{}"); if (!lensInteracted.current) { if (["working", "attention", "local", "ignored"].includes(lens.view)) setView(lens.view); if (["name", "size", "git", "github", "sync"].includes(lens.sortKey)) setSortKey(lens.sortKey); if (["asc", "desc"].includes(lens.sortDirection)) setSortDirection(lens.sortDirection); } } catch { /* safe defaults */ } setLensReady(true); void loadRef.current(false); }, 0); return () => { window.clearTimeout(initial); if (retryTimer.current) window.clearTimeout(retryTimer.current); }; }, []);
  useEffect(() => { if (!lensReady) return; window.localStorage.setItem("project-deck-lens-v1", JSON.stringify({ view, sortKey, sortDirection })); }, [lensReady, view, sortKey, sortDirection]);
  useEffect(() => { const id = window.setTimeout(() => { if (!window.localStorage.getItem("project-deck-onboarding-complete")) setOnboardingOpen(true); void refreshGithubAuth(); }, 0); return () => window.clearTimeout(id); }, [refreshGithubAuth]);
  useEffect(() => { if (!authCode || githubAuth.connected) return; const id = window.setInterval(() => void refreshGithubAuth(), 3000); return () => window.clearInterval(id); }, [authCode, githubAuth.connected, refreshGithubAuth]);
  useEffect(() => { if (!authCode || !githubAuth.connected) return; const id = window.setTimeout(() => { setAuthCode(null); setToast(`GitHub connected as @${githubAuth.login}.`); void loadRef.current(false, true); }, 0); return () => window.clearTimeout(id); }, [authCode, githubAuth.connected, githubAuth.login]);
  useEffect(() => { if (!data?.enriching) return; const id = window.setInterval(() => void loadRef.current(false), 5000); return () => window.clearInterval(id); }, [data?.enriching]);
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 4000); return () => window.clearTimeout(id); }, [toast]);
  const updateProject = useCallback((project: ProjectRecord, scannedAt = new Date().toISOString()) => setData((current) => current ? { ...current, scannedAt, projects: current.projects.map((item) => item.canonicalPath === project.canonicalPath ? project : item) } : current), []);
  const focusProjectAction = useCallback((projectPath: string) => {
    const row = [...document.querySelectorAll<HTMLElement>("[data-project-path]")].find((item) => item.dataset.projectPath === projectPath);
    row?.querySelector<HTMLElement>(".primary-action button, .project-action-error button")?.focus();
  }, []);
  const action = useCallback(async (project: ProjectRecord, kind: ProjectActionKind, payload: Record<string, unknown> = {}, directTrigger: HTMLElement | null = null) => {
    if (busyProject) return;
    const trigger = directTrigger || modal?.trigger || null;
    const label = kind === "link" && !project.git.isRepository ? "Initialize & link" : actionLabels[kind];
    setBusyProject(project.canonicalPath);
    setActionError(null);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(project.name)}/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as ActionResponse | ActionFailureResponse;
      if (!response.ok || !result.ok) {
        const failed: ActionFailureResponse = result.ok === false ? result : { ok: false, error: "The action could not be completed." };
        if (failed.project) updateProject(failed.project);
        const failure: ProjectActionFailure = { projectPath: project.canonicalPath, projectName: project.name, kind, label, message: failed.error || "The action could not be completed.", code: failed.code };
        setActionError(failure);
        const partialCodes = new Set(["initial_push_failed", "empty_initial_push_failed", "commit_push_failed", "create_remote_partial", "create_after_init_failed", "initialized_link_failed"]);
        if (failed.code && partialCodes.has(failed.code)) {
          setModal(null);
          requestAnimationFrame(() => focusProjectAction(project.canonicalPath));
        } else if (!modal) {
          requestAnimationFrame(() => trigger?.focus());
        }
        return;
      }
      const leavesActiveView = projectInView(project, view) && !projectInView(result.project, view);
      updateProject(result.project);
      setToast(result.message);
      setModal(null);
      requestAnimationFrame(() => {
        if (leavesActiveView) document.querySelector<HTMLElement>('.view-tabs button[aria-pressed="true"]')?.focus();
        else trigger?.focus();
      });
    } catch (caught) {
      setActionError({ projectPath: project.canonicalPath, projectName: project.name, kind, label, message: caught instanceof Error ? caught.message : "The action could not be completed." });
      if (!modal) requestAnimationFrame(() => trigger?.focus());
    } finally {
      setBusyProject(null);
    }
  }, [busyProject, focusProjectAction, modal, updateProject, view]);
  const allProjects = useMemo(() => data?.projects || [], [data?.projects]);
  const counts = useMemo(() => { const ignored = allProjects.filter((project) => project.preferences.ignored); const working = allProjects.filter((project) => !project.preferences.ignored); return { onDisk: allProjects.length, working: working.length, ignored: ignored.length, local: working.filter((project) => project.preferences.localOnly).length, attention: working.filter(needsAttention).length, bytes: allProjects.reduce((sum, project) => sum + (project.size.status === "complete" ? project.size.bytes : 0), 0) }; }, [allProjects]);
  const viewBase = useMemo(() => allProjects.filter((project) => projectInView(project, view)), [allProjects, view]);
  const visible = useMemo(() => { const needle = query.trim().toLowerCase(); return viewBase.filter((project) => !needle || [project.name, project.description.text, project.description.sourceLabel, project.canonicalPath, project.pathLabel, ...project.technologies, gitView(project).label, gitView(project).detail, project.git.branch, githubView(project).label, githubView(project).detail, project.github.repository?.name, project.github.repository?.nameWithOwner, syncView(project.sync.state, project.sync.ahead, project.sync.behind).label, project.sync.detail].filter(Boolean).join(" ").toLowerCase().includes(needle)).sort((a, b) => compareProjects(a, b, sortKey, sortDirection)); }, [query, sortDirection, sortKey, viewBase]);
  const copy = async (project: ProjectRecord) => { setCopyError(null); try { await navigator.clipboard.writeText(project.canonicalPath); setToast(`Absolute folder path copied for ${project.name}`); } catch { setCopyError(`Couldn’t copy the absolute folder path for ${project.name}. Select it from the project record and copy it manually: ${project.canonicalPath}`); } };
  const openModal = useCallback((next: NonNullable<ModalState>) => { setActionError(null); setModal(next); }, []);
  const closeModal = useCallback(() => { if (!modal) return; const trigger = modal.trigger; setModal(null); requestAnimationFrame(() => trigger?.focus()); }, [modal]);
  const chooseRoot = async (useNative: boolean) => { setRootBusy(true); setRootError(null); try { const response = await fetch(`${API_BASE}/api/root${useNative ? "/choose" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: useNative ? undefined : JSON.stringify({ path: rootDraft }) }); const result = await response.json() as ProjectScanResponse | { error: string }; if (!response.ok || "error" in result) throw new Error("error" in result ? result.error : "The folder could not be selected."); setData(result); setRootDraft(result.rootLabel); setRootPickerOpen(false); setToast(`Now scanning ${result.rootLabel}.`); } catch (caught) { setRootError(caught instanceof Error ? caught.message : "The folder could not be selected."); } finally { setRootBusy(false); } };
  const connectGithub = async () => { setAuthBusy(true); setAuthError(null); try { const response = await fetch(`${API_BASE}/api/github/auth`, { method: "POST" }); const result = await response.json() as { code?: string | null; connected?: boolean; error?: string }; if (!response.ok || result.error) throw new Error(result.error || "GitHub sign-in could not start."); if (result.connected) await refreshGithubAuth(); else if (result.code) setAuthCode(result.code); } catch (caught) { setAuthError(caught instanceof Error ? caught.message : "GitHub sign-in could not start."); } finally { setAuthBusy(false); } };
  const finishOnboarding = () => { window.localStorage.setItem("project-deck-onboarding-complete", "1"); setOnboardingOpen(false); };
  const viewCounts: Record<ProjectView, number> = { working: counts.working, attention: counts.attention, local: counts.local, ignored: counts.ignored };
  const emptyKind = !data || data.projects.length === 0 ? "root" : view === "working" && counts.working === 0 ? "ignored-only" : query && visible.length === 0 ? "query" : visible.length === 0 ? "view" : null;
  const scannerLabel = scannerError ? data ? "Scanner stale" : "Scanner offline" : loading && !data ? "Scanner checking" : "Scanner ready";
  return <main className="dashboard-shell"><header className="topbar"><a className="brand" href="#working-set"><span className="brand-mark"><GitBranch size={15}/></span><span>PROJECT DECK</span></a><div className="topbar-context"><span className={`availability ${scannerError ? "offline" : ""}`}><i/>{scannerLabel}</span><span className={`availability ${githubAuth.connected ? "online" : ""}`}><i/>{!githubAuth.checked ? "Checking GitHub" : githubAuth.connected ? `@${githubAuth.login}` : "GitHub optional"}</span><button className="button secondary" onClick={() => { setRootDraft(data?.rootLabel || "~/Documents"); setRootError(null); setRootPickerOpen(true); }}><Folder size={15}/> Choose folder</button><button className="button secondary" disabled={refreshing} onClick={() => void loadProjects(true, true)}><RefreshCw className={refreshing ? "spin" : ""} size={15}/>{refreshing ? "Refreshing…" : "Refresh"}</button></div></header>
    <div className="dashboard-content"><section className="working-header" id="working-set"><div><p className="kicker">LOCAL WORKING SET</p><h1>Projects on this computer.</h1><p>One ledger for local work, repository state, and what you intend to do next.</p></div><dl><div><dt>Root</dt><dd title={data?.rootPath}>{data?.rootLabel || "~/Documents"}</dd></div><div><dt>Last check</dt><dd>{data ? new Date(data.scannedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Waiting"}</dd></div><div><dt>On disk</dt><dd>{data ? counts.onDisk : "—"}</dd></div><div><dt>Measured</dt><dd>{data ? formatProjectSize(counts.bytes) : "—"}</dd></div></dl></section>
    <section className="control-band" aria-label="Working-set controls">
      <label className="search-field"><Search size={16}/><span className="sr-only">Search projects</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, description, source, path, technology, or state"/>{query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={15}/></button>}</label>
      <div className="view-tabs" role="group" aria-label="Project view">{(Object.keys(viewLabels) as ProjectView[]).map((item) => <button key={item} aria-pressed={view === item} onClick={() => { lensInteracted.current = true; setView(item); }}>{viewLabels[item]} <span>{data ? viewCounts[item] : "—"}</span></button>)}</div>
      <div className="sort-controls" role="group" aria-label="Sort projects"><label><span>Sort</span><select value={sortKey} onChange={(event) => { lensInteracted.current = true; setSortKey(event.target.value as SortKey); }} aria-label="Sort projects by">{(Object.keys(sortLabels) as SortKey[]).map((item) => <option key={item} value={item}>{sortLabels[item]}</option>)}</select></label><button className="direction-button" onClick={() => { lensInteracted.current = true; setSortDirection((current) => current === "asc" ? "desc" : "asc"); }} aria-label={`${sortDirection === "asc" ? "Ascending" : "Descending"}, change sort direction`} aria-pressed={sortDirection === "desc"}>{sortDirection === "asc" ? <ArrowUp size={15}/> : <ArrowDown size={15}/>} {sortDirection === "asc" ? "Ascending" : "Descending"}</button></div>
    </section>
    {scannerError && data && <div className="stale-banner" role="status"><AlertCircle size={16}/><div><strong>Local scanner unavailable</strong><span>Showing cached data from {new Date(data.scannedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Search, sorting, paths, and local intent remain available; repository facts may be stale.</span></div><button className="button secondary" onClick={() => void loadProjects(true, true)}>Retry</button></div>}{copyError && <div className="error-banner" role="alert"><AlertCircle size={16}/><span>{copyError}</span><button className="icon-button" onClick={() => setCopyError(null)} aria-label="Dismiss copy error"><X size={15}/></button></div>}
    <section className="ledger" aria-busy={loading && !data}><header><div><p className="kicker">PROJECT LEDGER</p><h2>{!data ? `— in ${viewLabels[view]}` : query ? `${visible.length} of ${viewBase.length} in ${viewLabels[view]}` : `${viewBase.length} in ${viewLabels[view]}`}{data?.enriching ? <span> · enriching local facts</span> : null}</h2></div><div className="ledger-key" aria-hidden="true"><span>Identity</span><span>Facts</span><span>Git → GitHub → Sync</span><span>Action</span></div></header><ul className="project-list">{loading && !data ? Array.from({ length: 4 }, (_, index) => <Skeleton key={index}/>) : visible.map((project) => <ProjectRow key={project.canonicalPath} project={project} githubAvailable={Boolean(data?.github.available)} busy={busyProject === project.canonicalPath} enriching={Boolean(data?.enriching)} actionError={actionError} onDismissActionError={() => setActionError(null)} onAction={(item, kind, trigger) => void action(item, kind, {}, trigger)} onCopy={(item) => void copy(item)} onModal={openModal}/>)}</ul>
    {!loading && !data && scannerError && <div className="state-surface" role="status"><AlertCircle/><p className="kicker">LOCAL SERVICE · OFFLINE</p><h3>Scanner connection lost</h3><p>{retryPending ? "Retrying automatically while keeping this page ready." : retryExhausted ? "The scanner is still unavailable. Retry when the local service is ready." : "Project Deck could not read the local inventory."}</p><button className="button primary" onClick={() => void loadProjects(false, true)}><RefreshCw size={15}/> Retry now</button></div>}
    {!loading && data && emptyKind && <div className="state-surface"><Folder/><p className="kicker">{emptyKind === "root" ? "ROOT · EMPTY" : emptyKind === "ignored-only" ? "WORKING SET · EMPTY" : "VIEW · EMPTY"}</p><h3>{emptyKind === "root" ? "No project folders found" : emptyKind === "ignored-only" ? "Every project is ignored" : emptyKind === "query" ? `No matches in ${viewLabels[view]}` : `${viewLabels[view]} is empty`}</h3><p>{emptyKind === "root" ? `${data.rootLabel} is available, but it contains no direct child folders.` : emptyKind === "ignored-only" ? "Nothing was deleted. Your projects remain on disk and are available in Ignored." : emptyKind === "query" ? "Clear the search to return to this view without changing its sort or scope." : view === "ignored" ? "Ignored projects will appear here and can be restored." : "No projects currently meet this view’s rules."}</p>{emptyKind === "ignored-only" ? <button className="button primary" onClick={() => setView("ignored")}>Show ignored projects</button> : emptyKind === "query" ? <button className="button secondary" onClick={() => setQuery("")}>Clear search</button> : null}</div>}</section></div>
    <div className="sr-only" role="status" aria-live="polite">{refreshing ? "Refreshing project facts" : toast || ""}</div>{toast && <div className="toast" role="status"><Check size={15}/>{toast}</div>}
    {modal?.type === "create" || modal?.type === "link" || modal?.type === "push" ? <RepoActionModal modal={modal} busy={busyProject === modal.project.canonicalPath} error={actionError} onClose={closeModal} onSubmit={(payload) => void action(modal.project, modal.type === "create" ? "create-repo" : modal.type === "link" ? "link" : "push", payload)}/> : null}
    {modal?.type === "preference" && <PreferenceDialog
      modal={modal} busy={busyProject === modal.project.canonicalPath} error={actionError} onClose={closeModal}
      onConfirm={() => void action(modal.project, "preferences", { [modal.kind]: !modal.project.preferences[modal.kind] })}
    />}
    {modal?.type === "description" && <DescriptionDialog
      modal={modal} busy={busyProject === modal.project.canonicalPath} error={actionError} onClose={closeModal}
      onSave={(description) => void action(modal.project, "preferences", { description })}
      onClear={() => void action(modal.project, "preferences", { description: null })}
    />}
    {onboardingOpen && <Onboarding
      rootLabel={data?.rootLabel || "~/Documents"} auth={githubAuth} authCode={authCode} busy={authBusy} error={authError}
      onChooseFolder={() => { setRootDraft(data?.rootLabel || "~/Documents"); setRootError(null); setRootPickerOpen(true); }}
      onConnect={() => void connectGithub()} onDone={finishOnboarding}
    />}
    {rootPickerOpen && <RootPicker value={rootDraft} busy={rootBusy} error={rootError} onChange={setRootDraft} onClose={() => !rootBusy && setRootPickerOpen(false)} onBrowse={() => void chooseRoot(true)} onSave={() => void chooseRoot(false)}/>}</main>;
}
