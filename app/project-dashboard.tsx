"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFailureResponse, ActionResponse, ProjectRecord, ProjectScanResponse, RootSelectionResponse } from "@/lib/project-types";
import { attentionReason, compareProjects, gitPresentation, githubPresentation, hasDisconnectedHistory, needsAttention, projectActivity, projectInView, projectSearchText, syncPresentation, type ProjectView, type SortDirection, type SortKey } from "@/lib/project-ledger";
import { formatProjectSize } from "@/lib/format-project-size";
import { AlertCircle, ArrowDown, ArrowUp, Check, Copy, ExternalLink, Folder, GitBranch, Github, LoaderCircle, Lock, MoreHorizontal, Pencil, RefreshCw, Search, Unlock, X } from "@/app/icons";

const RETRY_MS = 4_000;
const API_TIMEOUT_MS = 5_000;
const API_PORT = process.env.NEXT_PUBLIC_PROJECT_DECK_API_PORT || "4317";
const viewLabels: Record<ProjectView, string> = { working: "Working set", attention: "Needs attention", local: "GitHub ignored", ignored: "Ignored" };
const sortLabels: Record<SortKey, string> = { name: "Project", size: "Total size", git: "Git", github: "GitHub", sync: "Sync" };
type GithubAuthState = { checked: boolean; cliAvailable: boolean; connected: boolean; login: string | null };
type ProjectActionKind = "init" | "link" | "create-repo" | "pull" | "push" | "preferences";
type RepoModal = { type: "create" | "link" | "pull" | "push"; project: ProjectRecord; trigger: HTMLElement | null };
type PreferenceModal = { type: "preference"; kind: "ignored" | "localOnly"; project: ProjectRecord; trigger: HTMLElement | null };
type DescriptionModal = { type: "description"; project: ProjectRecord; trigger: HTMLElement | null };
type ModalState = RepoModal | PreferenceModal | DescriptionModal | null;
type ProjectActionFailure = { projectPath: string; projectName: string; kind: ProjectActionKind; label: string; message: string; code?: string };
const actionLabels: Record<ProjectActionKind, string> = { init: "Initialize Git", link: "Link repository", "create-repo": "Create GitHub repository", pull: "Pull from GitHub", push: "Publish to GitHub", preferences: "Update project preference" };

function apiUrl(path: string) {
  if (typeof window === "undefined") return path;
  return `${window.location.protocol}//${window.location.hostname}:${API_PORT}${path}`;
}

async function fetchLocal(path: string, init: RequestInit = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(apiUrl(path), { ...init, signal: controller.signal });
  } catch (caught) {
    if (controller.signal.aborted) throw new Error("The local service did not respond. Confirm Project Deck is running, then try again.");
    throw caught;
  } finally {
    window.clearTimeout(timeout);
  }
}

function refreshingDetail(detail: string, refreshing: boolean) {
  return refreshing ? `${detail} · Refreshing…` : detail;
}

function latestGitActivity(project: ProjectRecord) {
  const activity = projectActivity(project);
  if (!activity.at) return { at: null, relative: "No Git activity", exact: "No local commit or GitHub push was found.", source: "No commit or push found" };
  const date = new Date(activity.at);
  if (Number.isNaN(date.getTime())) return { at: null, relative: "Unavailable", exact: "Git activity timestamp unavailable", source: "Timestamp unavailable" };
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  const relative = days === 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days} days ago` : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  return { at: activity.at, relative, exact: date.toLocaleString(), source: activity.source === "local_commit" ? "Local commit" : project.github.state === "matched" ? "GitHub push · repository not linked locally" : "GitHub push" };
}

function exactTimestamp(value: string | null | undefined) {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not reported" : date.toLocaleString();
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
  const pull = modal.type === "pull";
  const emptyInitial = !modal.project.git.hasCommits && modal.project.git.changeCount === 0;
  const title = create ? "Create a GitHub repository" : link ? modal.project.git.isRepository ? "Link repository" : "Initialize & link" : pull ? `Pull ${modal.project.sync.behind} remote commit${modal.project.sync.behind === 1 ? "" : "s"}` : emptyInitial ? "Create initial commit & push" : modal.project.git.changeCount ? `Commit & push ${modal.project.git.changeCount} local change${modal.project.git.changeCount === 1 ? "" : "s"}` : "Push to GitHub";
  const matchedRepository = modal.project.github.repository?.nameWithOwner || "the matched GitHub repository";
  const consequence = create
    ? modal.project.git.isRepository
      ? "This creates the GitHub repository and adds origin. It does not change files or commits and does not push."
      : "This initializes local Git, creates the GitHub repository, and adds origin. It does not create a commit or push files; publishing remains a separate action."
    : link
      ? modal.project.git.isRepository
        ? `This adds ${matchedRepository} as origin. It does not change project files or commits.`
        : `This initializes local Git and adds ${matchedRepository} as origin. It does not change project files or create commits.`
      : pull
        ? `This fetches GitHub and fast-forwards ${modal.project.git.branch || "the current branch"} by ${modal.project.sync.behind} commit${modal.project.sync.behind === 1 ? "" : "s"}. It refuses to run if there are local changes or the histories have diverged.`
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
      : !link && !pull && (modal.project.git.changeCount > 0 || !modal.project.git.hasCommits) && <label className="field"><span>Commit message</span><input data-dialog-initial="true" value={message} maxLength={120} onChange={(event) => setMessage(event.target.value)} /><small>Obvious untracked secret files are blocked before staging.</small></label>}
    {error && error.projectPath === modal.project.canonicalPath && <div className="action-dialog-error" role="alert"><strong>{error.label} failed for {error.projectName}</strong><span>{error.message}</span></div>}
    <div className="dialog-actions"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button ref={submit} data-dialog-initial={link || pull ? "true" : undefined} className="button primary" disabled={busy || (!create && !link && !pull && (modal.project.git.changeCount > 0 || !modal.project.git.hasCommits) && !message.trim())} onClick={() => onSubmit(create ? { visibility } : link || pull ? {} : { message })}>{busy ? <LoaderCircle className="spin" size={15}/> : create || link ? <Github size={15}/> : pull ? <ArrowDown size={15}/> : <ArrowUp size={15}/>} {busy ? "Working…" : title}</button></div>
  </DialogFrame>;
}

function PreferenceDialog({ modal, busy, error, onClose, onConfirm }: { modal: PreferenceModal; busy: boolean; error: ProjectActionFailure | null; onClose: () => void; onConfirm: () => void }) {
  const isIgnore = modal.kind === "ignored";
  const active = modal.project.preferences[modal.kind];
  const hasGithubRepository = Boolean(modal.project.github.repository) || modal.project.github.state === "linked" || modal.project.github.state === "matched";
  const title = isIgnore ? active ? "Restore to working set" : "Ignore project" : active ? hasGithubRepository ? "Resume GitHub sync" : "Allow GitHub" : hasGithubRepository ? "Ignore GitHub sync" : "Keep local only";
  const copy = isIgnore
    ? active ? "This returns the project to the working set. Nothing in its folder will change." : "This hides the project from normal working-set views. It remains on disk, scanned, searchable in Ignored, and can be restored."
    : active ? "GitHub publishing, pull actions, and remote attention will return. No repository action will run until you choose one." : hasGithubRepository
      ? "This keeps the existing GitHub repository and remote unchanged. Project Deck will hide push and pull actions and ignore remote sync when deciding whether this project needs attention."
      : "Project Deck will stop suggesting GitHub publishing. Local Git remains available and no repository action will run.";
  return <DialogFrame titleId="preference-title" busy={busy} onClose={onClose}><p className="kicker">PROJECT INTENT · {modal.project.name}</p><h2 id="preference-title">{title}</h2><p>{copy}</p>{error?.projectPath === modal.project.canonicalPath && <div className="action-dialog-error" role="alert"><strong>{error.label} failed for {error.projectName}</strong><span>{error.message}</span></div>}<div className="dialog-actions"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button data-dialog-initial="true" className="button primary" onClick={onConfirm} disabled={busy}>{busy && <LoaderCircle className="spin" size={15}/>} {title}</button></div></DialogFrame>;
}

function DescriptionDialog({ modal, busy, error, onClose, onSave, onClear }: { modal: DescriptionModal; busy: boolean; error: ProjectActionFailure | null; onClose: () => void; onSave: (description: string) => void; onClear: () => void }) {
  const [value, setValue] = useState(modal.project.description.source === "local" ? modal.project.description.text : "");
  return <DialogFrame titleId="description-title" busy={busy} onClose={onClose}><p className="kicker">LOCAL NOTE · {modal.project.name}</p><h2 id="description-title">Edit local description</h2><p>This note is stored in Project Deck for this absolute folder path. It never edits README, manifests, or Git.</p><label className="field"><span>Project description</span><textarea data-dialog-initial="true" rows={6} maxLength={2000} value={value} onChange={(event) => setValue(event.target.value)} placeholder={modal.project.description.text || "What is this project for?"}/><small>{value.length} / 2000</small></label>{error?.projectPath === modal.project.canonicalPath && <div className="action-dialog-error" role="alert"><strong>{error.label} failed for {error.projectName}</strong><span>{error.message}</span></div>}<div className="dialog-actions split">{modal.project.description.source === "local" ? <button className="button quiet danger" onClick={onClear} disabled={busy}>Clear local description</button> : <span/>}<button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={() => onSave(value)} disabled={busy || !value.trim()}>{busy && <LoaderCircle className="spin" size={15}/>} Save description</button></div></DialogFrame>;
}

function GitColumnAction({ project, busy, onAction }: { project: ProjectRecord; busy: boolean; onAction: (kind: "init", trigger: HTMLElement) => void }) {
  const git = gitPresentation(project);
  if (git.key === "checking") return <span className="action-guidance"><LoaderCircle className="spin" size={13}/> Checking local Git…</span>;
  if (git.key === "not_initialized") return <div className="rail-column-action"><button className="button primary" disabled={busy} onClick={(event) => onAction("init", event.currentTarget)}><GitBranch size={14}/> Initialize Git</button><small>Creates local .git only</small></div>;
  if (project.git.metadataSource === "agent_external") return <span className="action-guidance"><Check size={13}/> Agent-managed Git</span>;
  return null;
}

function GithubColumnAction({ project, githubAvailable, busy, onModal }: { project: ProjectRecord; githubAvailable: boolean; busy: boolean; onModal: (modal: RepoModal) => void }) {
  const github = githubPresentation(project);
  if (project.preferences.localOnly) return project.github.repository
    ? <div className="rail-column-action"><a href={project.github.repository.url} target="_blank" rel="noreferrer">Open repository <ExternalLink size={12}/></a><small>GitHub sync actions and alerts are ignored</small></div>
    : <span className="action-guidance"><Check size={13}/> GitHub publishing ignored</span>;
  if (github.key === "checking") return <span className="action-guidance"><LoaderCircle className="spin" size={13}/> Finding repositories…</span>;
  if (github.key === "linked") return project.github.repository ? <div className="rail-column-action"><a href={project.github.repository.url} target="_blank" rel="noreferrer">Open repository <ExternalLink size={12}/></a></div> : null;
  if (project.git.metadataSource === "agent_external") return <div className="rail-column-action">
    <span className="action-guidance">Create or link this repository through the active coding session</span>
    {project.github.repository && <a href={project.github.repository.url} target="_blank" rel="noreferrer">Open matched repository <ExternalLink size={12}/></a>}
  </div>;
  if (github.key === "match_found") return <div className="rail-column-action">
    {!hasDisconnectedHistory(project) && <button className="button primary" disabled={busy} onClick={(event) => onModal({ type: "link", project, trigger: event.currentTarget })}><Github size={14}/> {project.git.isRepository ? "Link repository" : "Initialize & link"}</button>}
    {project.github.repository && <a href={project.github.repository.url} target="_blank" rel="noreferrer">Open matched repository <ExternalLink size={12}/></a>}
  </div>;
  if (github.key === "none" && githubAvailable) return <div className="rail-column-action"><button className="button primary" disabled={busy} onClick={(event) => onModal({ type: "create", project, trigger: event.currentTarget })}><Github size={14}/> Create repository</button></div>;
  if (github.key === "sign_in" && !githubAvailable) return <span className="action-guidance">Connect GitHub above to discover repositories</span>;
  return null;
}

function GithubPreferenceControl({ project, busy, onModal }: { project: ProjectRecord; busy: boolean; onModal: (modal: PreferenceModal) => void }) {
  const localOnly = project.preferences.localOnly;
  const hasGithubRepository = Boolean(project.github.repository) || project.github.state === "linked" || project.github.state === "matched";
  const label = localOnly
    ? hasGithubRepository ? "Resume GitHub sync" : "Allow GitHub"
    : hasGithubRepository ? "Ignore GitHub sync" : "Keep local only";
  return <button
    className={`rail-preference-button ${localOnly ? "active" : ""}`}
    type="button"
    aria-pressed={localOnly}
    disabled={busy}
    onClick={(event) => onModal({ type: "preference", kind: "localOnly", project, trigger: event.currentTarget })}
  >
    {localOnly ? <Unlock size={13}/> : <Lock size={13}/>} {label}
  </button>;
}

function SyncColumnAction({ project, busy, onModal }: { project: ProjectRecord; busy: boolean; onModal: (modal: RepoModal) => void }) {
  const git = gitPresentation(project);
  const sync = syncPresentation(project);
  const externallyManaged = project.git.metadataSource === "agent_external";
  let action: React.ReactNode = null;
  if (sync.key === "history_mismatch") action = <span className="action-guidance danger"><AlertCircle size={13}/> Review the evidence below before pushing</span>;
  else if (project.preferences.localOnly) action = <span className="action-guidance"><Check size={13}/> Sync actions and alerts ignored</span>;
  else if (sync.key === "checking") action = <span className="action-guidance"><LoaderCircle className="spin" size={13}/> Comparing refs…</span>;
  else if (sync.key === "behind" && externallyManaged) action = <span className="action-guidance caution">Pull through the active coding session</span>;
  else if (sync.key === "behind" && (!project.git.statusAvailable || git.key === "offloaded" || git.key === "not_checked")) action = <span className="action-guidance">Make working files available, then refresh before pulling</span>;
  else if (sync.key === "behind" && project.git.changeCount > 0) action = <span className="action-guidance caution">Commit or stash local changes before pulling</span>;
  else if (sync.key === "behind") action = <div className="rail-column-action"><button className="button primary" disabled={busy} onClick={(event) => onModal({ type: "pull", project, trigger: event.currentTarget })}><ArrowDown size={14}/> Pull {project.sync.behind} commit{project.sync.behind === 1 ? "" : "s"}</button></div>;
  else if (sync.key === "diverged") action = <span className="action-guidance caution">Histories diverged — reconcile outside Project Deck</span>;
  else if (git.key === "offloaded" || git.key === "not_checked") action = <span className="action-guidance">Make working files available, then refresh</span>;
  else if (sync.key === "not_checked") action = <span className="action-guidance">Refresh to check the comparison again</span>;
  else if (externallyManaged && (git.key === "changes" || git.key === "no_commits" || sync.key === "ahead" || sync.key === "not_pushed")) action = <span className="action-guidance caution">Commit and push through the active coding session</span>;
  else if (project.github.state === "linked" && (git.key === "no_commits" || git.key === "changes" || sync.key === "ahead" || sync.key === "not_pushed")) {
    const label = !project.git.hasCommits ? project.git.changeCount ? "Commit & push" : "Initial commit & push" : project.git.changeCount ? `Commit & push ${project.git.changeCount} change${project.git.changeCount === 1 ? "" : "s"}` : "Push to GitHub";
    action = <div className="rail-column-action"><button className="button primary" disabled={busy} onClick={(event) => onModal({ type: "push", project, trigger: event.currentTarget })}><ArrowUp size={14}/> {label}</button></div>;
  } else if (sync.key === "in_sync") action = <span className="action-guidance good"><Check size={13}/> Up to date</span>;
  else if (sync.key === "not_linked" && project.github.state === "matched") action = <span className="action-guidance">Link the repository in the GitHub column</span>;
  return <>{action}<StatusEvidence project={project}/></>;
}

function StatusEvidence({ project }: { project: ProjectRecord }) {
  const git = gitPresentation(project);
  const github = githubPresentation(project);
  const sync = syncPresentation(project);
  const repository = project.github.repository;
  return <details className="status-evidence" open={hasDisconnectedHistory(project) || undefined}>
    <summary>Status evidence</summary>
    <dl>
      <div><dt>Local Git</dt><dd>{project.git.metadataSource === "agent_external" ? "Agent-managed external Git metadata. " : ""}{git.label}. {git.detail}</dd></div>
      <div><dt>Origin</dt><dd>{project.github.state === "linked" ? repository?.nameWithOwner || "GitHub origin configured" : "No origin remote is configured in this folder"}</dd></div>
      <div><dt>GitHub</dt><dd>{repository ? `${repository.nameWithOwner} · latest push ${exactTimestamp(repository.pushedAt)}` : github.detail}</dd></div>
      <div><dt>Comparison</dt><dd>{sync.detail}</dd></div>
    </dl>
  </details>;
}

function ProjectRow({ project, githubAvailable, busy, actionError, onAction, onCopy, onModal, onDismissActionError }: { project: ProjectRecord; githubAvailable: boolean; busy: boolean; actionError: ProjectActionFailure | null; onAction: (project: ProjectRecord, kind: "init", trigger: HTMLElement) => void; onCopy: (project: ProjectRecord) => void; onModal: (modal: NonNullable<ModalState>) => void; onDismissActionError: () => void }) {
  const git = gitPresentation(project); const github = githubPresentation(project); const sync = syncPresentation(project); const update = latestGitActivity(project);
  const SyncIcon = sync.key === "checking" ? LoaderCircle : sync.key === "in_sync" ? Check : sync.key === "ahead" || sync.key === "not_pushed" ? ArrowUp : sync.key === "behind" ? ArrowDown : sync.key === "diverged" || sync.key === "history_mismatch" ? AlertCircle : Github;
  const descriptionMissing = project.description.source === "none";
  return <li className="project-row" data-project={project.name} data-project-path={project.canonicalPath}>
    <article className="project-record" aria-labelledby={`project-${encodeURIComponent(project.canonicalPath)}`}>
      <div className="project-identity">
        <div className="identity-heading"><span className="project-index" aria-hidden="true">{project.name.slice(0, 2).toUpperCase()}</span><div><h2 id={`project-${encodeURIComponent(project.canonicalPath)}`}>{project.name}</h2><div className="intent-list">{project.preferences.localOnly && <span>{project.github.repository ? "Sync ignored" : "Local only"}</span>}{project.preferences.ignored && <span>Ignored</span>}{needsAttention(project) && !project.preferences.ignored && <span className="attention-intent">Needs attention</span>}</div></div><details className="project-menu" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.removeAttribute("open"); event.currentTarget.querySelector<HTMLElement>("summary")?.focus(); } }}><summary role="button" aria-label={`Description options for ${project.name}`}><MoreHorizontal size={18}/></summary><div role="menu"><button role="menuitem" onClick={(event) => onModal({ type: "description", project, trigger: event.currentTarget })}><Pencil size={14}/> {descriptionMissing ? "Add local description" : "Edit local description"}</button></div></details></div>
        <div className={`description ${descriptionMissing ? "missing" : ""}`}>{project.description.source === "checking" ? <p>Checking local description…</p> : descriptionMissing ? <><p>No suitable local description found</p><button onClick={(event) => onModal({ type: "description", project, trigger: event.currentTarget })}>Add local description</button></> : <><p aria-label={project.description.text}>{project.description.compact}</p><span>{project.description.sourceLabel}</span></>}</div>
        <div className="path-line"><span>Folder path</span><code>{project.canonicalPath}</code><button onClick={() => onCopy(project)} aria-label={`Copy absolute folder path for ${project.name}`}><Copy size={13}/> Copy folder path</button></div>
        <div className="working-set-preference"><span>Working set</span><button type="button" className={project.preferences.ignored ? "active" : ""} aria-pressed={project.preferences.ignored} disabled={busy} onClick={(event) => onModal({ type: "preference", kind: "ignored", project, trigger: event.currentTarget })}>{project.preferences.ignored ? "Restore to working set" : "Ignore project"}</button></div>
      </div>
      <div className="project-facts"><div><span>Total size</span><strong>{project.transient?.size === "checking" ? "Measuring…" : project.size.status === "complete" ? formatProjectSize(project.size.bytes) : "Unavailable"}</strong></div><div><span>Latest Git activity:</span><time dateTime={update.at || undefined} title={update.exact} aria-label={`Latest Git activity: ${update.relative}. ${update.source}. Exact time: ${update.exact}`}>{update.relative}<span className="sr-only"> · {update.exact}</span></time><small className="activity-source">{update.source}</small></div>{project.technologies.length > 0 && <div className="technology-list" aria-label="Technologies">{project.technologies.join(" · ")}</div>}{needsAttention(project) && <p className="attention-reason">{attentionReason(project)}</p>}</div>
      <div className="repository-rail" aria-label={`Repository state for ${project.name}`}>
        <div className={`rail-stop ${git.tone}`} data-state-key={git.key}><span><GitBranch size={14}/> Git</span><strong>{git.label}</strong><small>{refreshingDetail(git.detail, git.refreshing)}</small><GitColumnAction project={project} busy={busy} onAction={(kind, trigger) => onAction(project, kind, trigger)}/></div>
        <div className={`rail-stop ${github.tone}`} data-state-key={github.key}><span><Github size={14}/> GitHub</span><strong>{github.label}</strong><small>{refreshingDetail(github.detail, github.refreshing)}</small><GithubColumnAction project={project} githubAvailable={githubAvailable} busy={busy} onModal={onModal}/><GithubPreferenceControl project={project} busy={busy} onModal={onModal}/></div>
        <div className={`rail-stop ${sync.tone}`} data-state-key={sync.key}><span><SyncIcon className={sync.key === "checking" ? "spin" : undefined} size={14}/> Sync</span><strong>{sync.label}</strong><small>{refreshingDetail(sync.detail, sync.refreshing)}</small><SyncColumnAction project={project} busy={busy} onModal={onModal}/></div>
      </div>
      {actionError?.projectPath === project.canonicalPath && <div className="project-action-error row-action-error" role="alert"><strong>{actionError.label} failed for {project.name}</strong><p>{actionError.message}</p><button onClick={onDismissActionError}>Dismiss</button></div>}
    </article>
  </li>;
}

function Skeleton() { return <li className="project-row skeleton" aria-hidden="true"><div className="sk sk-wide"/><div className="sk"/><div className="sk sk-rail"/></li>; }

function LedgerColumns({ sortKey, sortDirection, onSort }: { sortKey: SortKey; sortDirection: SortDirection; onSort: (key: SortKey) => void }) {
  return <div className="ledger-columns" aria-label="Sortable project columns">
    {(Object.keys(sortLabels) as SortKey[]).map((key) => {
      const active = sortKey === key;
      const nextDirection = active ? sortDirection === "asc" ? "descending" : "ascending" : key === "size" ? "descending" : "ascending";
      const current = active ? `, sorted ${sortDirection === "asc" ? "ascending" : "descending"}` : "";
      return <button key={key} type="button" data-sort-key={key} className={active ? "active" : ""} aria-pressed={active} aria-label={`${sortLabels[key]}${current}. Activate to sort ${nextDirection}.`} onClick={() => onSort(key)}>
        <span>{sortLabels[key]}</span>{active && (sortDirection === "asc" ? <ArrowUp size={14} aria-hidden="true"/> : <ArrowDown size={14} aria-hidden="true"/>)}
      </button>;
    })}
  </div>;
}

function RootPicker({ currentRoot, value, busy, error, onChange, onClose, onBrowse, onSave }: { currentRoot: string; value: string; busy: boolean; error: string | null; onChange: (value: string) => void; onClose: () => void; onBrowse: () => void; onSave: () => void }) {
  return <DialogFrame titleId="root-picker-title" busy={busy} onClose={onClose} className="root-picker"><p className="kicker">PROJECT SOURCE</p><h2 id="root-picker-title">Change parent folder</h2><p>Currently using <code>{currentRoot}</code>. Each direct child folder in the selected parent becomes one project.</p><label className="field"><span>Folder path</span><input value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && value.trim() && !busy) onSave(); }} placeholder="~/Documents"/><small>Use an absolute path or a path beginning with ~/.</small></label>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions split"><button className="button quiet" onClick={onBrowse} disabled={busy}><Folder size={15}/> Browse…</button><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={onSave} disabled={busy || !value.trim()}>{busy ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>} {busy ? "Changing…" : "Use this folder"}</button></div></DialogFrame>;
}

function Onboarding({ rootLabel, auth, authCode, busy, error, onChooseFolder, onConnect, onDone }: { rootLabel: string; auth: GithubAuthState; authCode: string | null; busy: boolean; error: string | null; onChooseFolder: () => void; onConnect: () => void; onDone: () => void }) {
  const dialog = useRef<HTMLElement>(null); const stayOpen = useCallback(() => {}, []); useDialogFocus(dialog, busy, stayOpen);
  return <div className="modal-backdrop onboarding-backdrop"><section ref={dialog} className="dialog onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><p className="kicker">WELCOME · LOCAL BY DESIGN</p><h2 id="onboarding-title">Build your working set.</h2><p>Project Deck stays on this computer. It inventories folders and reads descriptions from local README and project metadata; you can edit a private local description at any time.</p><div className="onboarding-steps"><section><span>01</span><div><strong>Choose the parent folder</strong><code>{rootLabel}</code><small>Every direct child folder becomes one project.</small></div><button className="button secondary" onClick={onChooseFolder}>Change folder</button></section><section><span>02</span><div><strong>Connect GitHub</strong>{!auth.checked ? <small>Checking your GitHub connection…</small> : auth.connected ? <small className="success-copy">Connected as @{auth.login}. Repository matching and sync status are available.</small> : authCode ? <><code className="device-code">{authCode}</code><small>Enter this one-time code on GitHub.</small></> : <small>Sign in to find, create, link, and sync GitHub repositories. You can skip this for local-only work.</small>}</div>{auth.checked && !auth.connected && auth.cliAvailable && (authCode ? <a className="button primary" href="https://github.com/login/device" target="_blank" rel="noreferrer">Open GitHub <ExternalLink size={14}/></a> : <button className="button secondary" onClick={onConnect} disabled={busy}><Github size={15}/> Connect GitHub</button>)}</section></div>{error && <p className="inline-error" role="alert">{error}</p>}<div className="onboarding-footer"><button className="button primary" onClick={onDone}>{auth.connected ? "Open working set" : "Continue with local projects"}</button></div></section></div>;
}

export function ProjectDashboard() {
  const [data, setData] = useState<ProjectScanResponse | null>(null); const [scannerError, setScannerError] = useState<string | null>(null); const [actionError, setActionError] = useState<ProjectActionFailure | null>(null); const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState(""); const [view, setView] = useState<ProjectView>("working"); const [sortKey, setSortKey] = useState<SortKey>("name"); const [sortDirection, setSortDirection] = useState<SortDirection>("asc"); const [lensReady, setLensReady] = useState(false);
  const [busyProject, setBusyProject] = useState<string | null>(null); const [modal, setModal] = useState<ModalState>(null); const [toast, setToast] = useState<string | null>(null); const [utilityError, setUtilityError] = useState<string | null>(null); const [retryPending, setRetryPending] = useState(false); const [retryExhausted, setRetryExhausted] = useState(false);
  const [rootPickerOpen, setRootPickerOpen] = useState(false); const [rootDraft, setRootDraft] = useState("~/Documents"); const [rootBusy, setRootBusy] = useState(false); const [rootOpening, setRootOpening] = useState(false); const [rootError, setRootError] = useState<string | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false); const [githubAuth, setGithubAuth] = useState<GithubAuthState>({ checked: false, cliAvailable: false, connected: false, login: null }); const [authCode, setAuthCode] = useState<string | null>(null); const [authBusy, setAuthBusy] = useState(false); const [authError, setAuthError] = useState<string | null>(null);
  const retryTimer = useRef<number | null>(null); const requestActive = useRef(false); const queuedLoad = useRef<{ refresh: boolean; manual: boolean } | null>(null); const outageAttempts = useRef(0); const dataRef = useRef<ProjectScanResponse | null>(null); const lensInteracted = useRef(false); const loadRef = useRef<(refresh?: boolean, manual?: boolean) => Promise<void>>(async () => {});
  const refreshGithubAuth = useCallback(async () => { try { const response = await fetchLocal("/api/github/auth", { cache: "no-store" }); const result = await response.json() as Omit<GithubAuthState, "checked">; setGithubAuth({ checked: true, ...result }); } catch { setGithubAuth({ checked: true, cliAvailable: false, connected: false, login: null }); } }, []);
  const loadProjects = useCallback(async (refresh = false, manual = false) => { if (requestActive.current) { if (manual) queuedLoad.current = { refresh, manual }; return; } if (manual) { outageAttempts.current = 0; if (retryTimer.current) window.clearTimeout(retryTimer.current); setRetryPending(false); setRetryExhausted(false); } const silentRetry = !manual && !refresh && outageAttempts.current > 0 && !dataRef.current; requestActive.current = true; if (refresh) setRefreshing(true); else if (!silentRetry) setLoading(true); if (!silentRetry) setScannerError(null); try { const response = await fetchLocal(`/api/projects${refresh ? "?refresh=remote" : ""}`, { cache: "no-store" }); if (!response.ok) throw new Error(); const result = await response.json() as ProjectScanResponse; dataRef.current = result; setData(result); outageAttempts.current = 0; setRetryPending(false); setRetryExhausted(false); setScannerError(null); } catch { setScannerError("The local scanner is unavailable."); if (!dataRef.current) { outageAttempts.current += 1; if (outageAttempts.current === 1) { setRetryPending(true); retryTimer.current = window.setTimeout(() => { void loadRef.current(false); }, RETRY_MS); } else { setRetryPending(false); setRetryExhausted(true); } } } finally { requestActive.current = false; setLoading(false); setRefreshing(false); const queued = queuedLoad.current; queuedLoad.current = null; if (queued) window.setTimeout(() => void loadRef.current(queued.refresh, queued.manual), 0); } }, []);
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
    row?.querySelector<HTMLElement>(".rail-column-action button, .project-action-error button")?.focus();
  }, []);
  const action = useCallback(async (project: ProjectRecord, kind: ProjectActionKind, payload: Record<string, unknown> = {}, directTrigger: HTMLElement | null = null) => {
    if (busyProject) return;
    const trigger = directTrigger || modal?.trigger || null;
    const label = kind === "link" && !project.git.isRepository ? "Initialize & link" : actionLabels[kind];
    setBusyProject(project.canonicalPath);
    setActionError(null);
    try {
      const response = await fetchLocal(`/api/projects/${encodeURIComponent(project.name)}/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, 120_000);
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
  const visible = useMemo(() => { const needle = query.trim().toLowerCase(); return viewBase.filter((project) => !needle || projectSearchText(project).includes(needle)).sort((a, b) => compareProjects(a, b, sortKey, sortDirection)); }, [query, sortDirection, sortKey, viewBase]);
  const sortFromHeader = useCallback((next: SortKey) => {
    lensInteracted.current = true;
    if (next === sortKey) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSortKey(next); setSortDirection(next === "size" ? "desc" : "asc"); }
  }, [sortKey]);
  const sortFromSelect = useCallback((next: SortKey) => {
    lensInteracted.current = true;
    if (next !== sortKey) setSortDirection(next === "size" ? "desc" : "asc");
    setSortKey(next);
  }, [sortKey]);
  const copy = async (project: ProjectRecord) => { setUtilityError(null); try { await navigator.clipboard.writeText(project.canonicalPath); setToast(`Absolute folder path copied for ${project.name}`); } catch { setUtilityError(`Couldn’t copy the absolute folder path for ${project.name}. Select it from the project record and copy it manually: ${project.canonicalPath}`); } };
  const openModal = useCallback((next: NonNullable<ModalState>) => { setActionError(null); setModal(next); }, []);
  const closeModal = useCallback(() => { if (!modal) return; const trigger = modal.trigger; setModal(null); requestAnimationFrame(() => trigger?.focus()); }, [modal]);
  const chooseRoot = async (useNative: boolean) => { const candidate = rootDraft.trim().replace(/[\\/]+$/u, ""); if (!useNative && data && [data.rootPath, data.rootLabel].some((root) => root.replace(/[\\/]+$/u, "") === candidate)) { setRootPickerOpen(false); setToast(`Already using ${data.rootLabel}.`); return; } setRootBusy(true); setRootError(null); try { const response = await fetchLocal(`/api/root${useNative ? "/choose" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: useNative ? undefined : JSON.stringify({ path: rootDraft }) }, useNative ? 300_000 : 60_000); const result = await response.json() as RootSelectionResponse | { error: string }; if (!response.ok || "error" in result) throw new Error("error" in result ? result.error : "The folder could not be selected."); if ("unchanged" in result) { setRootPickerOpen(false); setToast(`Already using ${data?.rootLabel || rootDraft}.`); return; } dataRef.current = result; setData(result); setRootDraft(result.rootLabel); setRootPickerOpen(false); setToast(`Folder changed to ${result.rootLabel}.`); } catch (caught) { setRootError(caught instanceof Error ? caught.message : "The folder could not be selected."); } finally { setRootBusy(false); } };
  const openRoot = async () => { if (!data || rootOpening) return; setRootOpening(true); setUtilityError(null); try { const response = await fetchLocal("/api/root/open", { method: "POST" }, 15_000); const result = await response.json() as { ok?: boolean; error?: string }; if (!response.ok || result.error) throw new Error(result.error || "The folder could not be opened."); setToast(`Opened ${data.rootLabel} in your file browser.`); } catch (caught) { setUtilityError(caught instanceof Error ? caught.message : "The folder could not be opened."); } finally { setRootOpening(false); } };
  const connectGithub = async () => { setAuthBusy(true); setAuthError(null); try { const response = await fetchLocal("/api/github/auth", { method: "POST" }, 30_000); const result = await response.json() as { code?: string | null; connected?: boolean; error?: string }; if (!response.ok || result.error) throw new Error(result.error || "GitHub sign-in could not start."); if (result.connected) await refreshGithubAuth(); else if (result.code) setAuthCode(result.code); } catch (caught) { setAuthError(caught instanceof Error ? caught.message : "GitHub sign-in could not start."); } finally { setAuthBusy(false); } };
  const finishOnboarding = () => { window.localStorage.setItem("project-deck-onboarding-complete", "1"); setOnboardingOpen(false); };
  const viewCounts: Record<ProjectView, number> = { working: counts.working, attention: counts.attention, local: counts.local, ignored: counts.ignored };
  const emptyKind = !data || data.projects.length === 0 ? "root" : view === "working" && counts.working === 0 ? "ignored-only" : query && visible.length === 0 ? "query" : visible.length === 0 ? "view" : null;
  const scannerLabel = scannerError ? data ? "Scanner stale" : "Scanner offline" : loading && !data ? "Scanner checking" : "Scanner ready";
  return <main className="dashboard-shell"><header className="topbar"><a className="brand" href="#working-set"><span className="brand-mark"><GitBranch size={15}/></span><span>PROJECT DECK</span></a><div className="topbar-context">
    <span className={`availability ${scannerError ? "offline" : ""}`}><i/>{scannerLabel}</span>
    <div className="root-control" aria-label={`Current folder: ${data?.rootLabel || "loading"}`}>
      <span className="root-current" title={data?.rootPath}><Folder size={15}/><span><small>Folder</small><strong>{data?.rootLabel || "Loading…"}</strong></span></span>
      <button className="root-action" disabled={!data || rootOpening} onClick={() => void openRoot()} aria-label={`Open ${data?.rootLabel || "current folder"} in file browser`}><ExternalLink size={14}/>{rootOpening ? "Opening…" : "Open"}</button>
      <button className="root-action" disabled={!data} onClick={() => { setRootDraft(data?.rootLabel || "~/Documents"); setRootError(null); setRootPickerOpen(true); }} aria-label="Change parent folder"><Pencil size={14}/>Change</button>
    </div>
    {!githubAuth.checked ? <span className="availability"><i/>Checking GitHub</span> : githubAuth.connected ? <span className="availability online"><i/>GitHub · @{githubAuth.login}</span> : authCode ? <a className="button github-connect" href="https://github.com/login/device" target="_blank" rel="noreferrer"><Github size={15}/> Finish GitHub sign-in</a> : <button className="button github-connect" onClick={() => void connectGithub()} disabled={authBusy}><Github size={15}/>{authBusy ? "Starting…" : "Connect GitHub"}</button>}
    <button className="button quiet refresh-button" disabled={refreshing} onClick={() => void loadProjects(true, true)}><RefreshCw className={refreshing ? "spin" : ""} size={15}/>{refreshing ? "Refreshing…" : "Refresh"}</button>
  </div></header>
    <div className="dashboard-content"><section className="working-header" id="working-set"><div><p className="kicker">LOCAL WORKING SET</p><h1>Projects on this computer.</h1><p>One ledger for local work, repository state, and what you intend to do next.</p></div><dl><div><dt>Working set</dt><dd>{data ? counts.working : "—"}</dd></div><div><dt>Last check</dt><dd>{data ? new Date(data.scannedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Waiting"}</dd></div><div><dt>On disk</dt><dd>{data ? counts.onDisk : "—"}</dd></div><div><dt>Measured</dt><dd>{data ? data.projects.some((project) => project.transient?.size === "checking") ? "Measuring…" : formatProjectSize(counts.bytes) : "—"}</dd></div></dl></section>
    <section className="control-band" aria-label="Working-set controls">
      <label className="search-field"><Search size={16}/><span className="sr-only">Search projects</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, description, source, path, technology, or state"/>{query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={15}/></button>}</label>
      <div className="view-tabs" role="group" aria-label="Project view">{(Object.keys(viewLabels) as ProjectView[]).map((item) => <button key={item} aria-pressed={view === item} onClick={() => { lensInteracted.current = true; setView(item); }}>{viewLabels[item]} <span>{data ? viewCounts[item] : "—"}</span></button>)}</div>
      <div className="sort-controls responsive-sort-controls" role="group" aria-label="Sort projects"><label><span>Sort</span><select value={sortKey} onChange={(event) => sortFromSelect(event.target.value as SortKey)} aria-label="Sort projects by">{(Object.keys(sortLabels) as SortKey[]).map((item) => <option key={item} value={item}>{sortLabels[item]}</option>)}</select></label><button className="direction-button" onClick={() => { lensInteracted.current = true; setSortDirection((current) => current === "asc" ? "desc" : "asc"); }} aria-label={`${sortDirection === "asc" ? "Ascending" : "Descending"}, change sort direction`} aria-pressed={sortDirection === "desc"}>{sortDirection === "asc" ? <ArrowUp size={15}/> : <ArrowDown size={15}/>} {sortDirection === "asc" ? "Ascending" : "Descending"}</button></div>
    </section>
    {scannerError && data && <div className="stale-banner" role="status"><AlertCircle size={16}/><div><strong>Local scanner unavailable</strong><span>Showing cached data from {new Date(data.scannedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Search, sorting, paths, and local intent remain available; repository facts may be stale.</span></div><button className="button secondary" onClick={() => void loadProjects(true, true)}>Retry</button></div>}
    {authCode && !githubAuth.connected && <div className="github-auth-banner" role="status"><Github size={17}/><div><strong>Finish connecting GitHub</strong><span>Enter code <code>{authCode}</code> on GitHub. Project Deck will update automatically after sign-in.</span></div><a className="button primary" href="https://github.com/login/device" target="_blank" rel="noreferrer">Open GitHub <ExternalLink size={14}/></a></div>}
    {authError && <div className="error-banner" role="alert"><AlertCircle size={16}/><span>{authError}</span><button className="icon-button" onClick={() => setAuthError(null)} aria-label="Dismiss GitHub connection error"><X size={15}/></button></div>}
    {utilityError && <div className="error-banner" role="alert"><AlertCircle size={16}/><span>{utilityError}</span><button className="icon-button" onClick={() => setUtilityError(null)} aria-label="Dismiss utility error"><X size={15}/></button></div>}
    <section className="ledger" aria-busy={loading && !data}><header><div><p className="kicker">PROJECT LEDGER</p><h2>{!data ? `— in ${viewLabels[view]}` : query ? `${visible.length} of ${viewBase.length} in ${viewLabels[view]}` : `${viewBase.length} in ${viewLabels[view]}`}{data?.enriching ? <span> · checking detailed repository status</span> : null}</h2></div><LedgerColumns sortKey={sortKey} sortDirection={sortDirection} onSort={sortFromHeader}/></header><ul className="project-list">{loading && !data ? Array.from({ length: 4 }, (_, index) => <Skeleton key={index}/>) : visible.map((project) => <ProjectRow key={project.canonicalPath} project={project} githubAvailable={Boolean(data?.github.available)} busy={busyProject === project.canonicalPath} actionError={actionError} onDismissActionError={() => setActionError(null)} onAction={(item, kind, trigger) => void action(item, kind, {}, trigger)} onCopy={(item) => void copy(item)} onModal={openModal}/>)}</ul>
    {!loading && !data && scannerError && <div className="state-surface" role="status"><AlertCircle/><p className="kicker">LOCAL SERVICE · OFFLINE</p><h3>Project Deck could not reach the local service</h3><p>{retryPending ? "Trying once more. This page will stay usable while Project Deck checks again." : retryExhausted ? "Restart Project Deck, then retry. No project files or settings were changed." : "The local project service did not respond."}</p><button className="button primary" onClick={() => void loadProjects(false, true)}><RefreshCw size={15}/> Retry now</button></div>}
    {!loading && data && emptyKind && <div className="state-surface"><Folder/><p className="kicker">{emptyKind === "root" ? "ROOT · EMPTY" : emptyKind === "ignored-only" ? "WORKING SET · EMPTY" : "VIEW · EMPTY"}</p><h3>{emptyKind === "root" ? "No project folders found" : emptyKind === "ignored-only" ? "Every project is ignored" : emptyKind === "query" ? `No matches in ${viewLabels[view]}` : `${viewLabels[view]} is empty`}</h3><p>{emptyKind === "root" ? `${data.rootLabel} is available, but it contains no direct child folders.` : emptyKind === "ignored-only" ? "Nothing was deleted. Your projects remain on disk and are available in Ignored." : emptyKind === "query" ? "Clear the search to return to this view without changing its sort or scope." : view === "ignored" ? "Ignored projects will appear here and can be restored." : "No projects currently meet this view’s rules."}</p>{emptyKind === "ignored-only" ? <button className="button primary" onClick={() => setView("ignored")}>Show ignored projects</button> : emptyKind === "query" ? <button className="button secondary" onClick={() => setQuery("")}>Clear search</button> : null}</div>}</section></div>
    <div className="sr-only" role="status" aria-live="polite">{refreshing ? "Refreshing project facts" : toast || ""}</div>{toast && <div className="toast" role="status"><Check size={15}/>{toast}</div>}
    {modal?.type === "create" || modal?.type === "link" || modal?.type === "pull" || modal?.type === "push" ? <RepoActionModal modal={modal} busy={busyProject === modal.project.canonicalPath} error={actionError} onClose={closeModal} onSubmit={(payload) => void action(modal.project, modal.type === "create" ? "create-repo" : modal.type === "link" ? "link" : modal.type === "pull" ? "pull" : "push", payload)}/> : null}
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
    {rootPickerOpen && <RootPicker currentRoot={data?.rootLabel || "~/Documents"} value={rootDraft} busy={rootBusy} error={rootError} onChange={setRootDraft} onClose={() => !rootBusy && setRootPickerOpen(false)} onBrowse={() => void chooseRoot(true)} onSave={() => void chooseRoot(false)}/>}</main>;
}
