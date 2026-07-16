"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionResponse, ProjectRecord, ProjectScanResponse, SyncState } from "@/lib/project-types";
import { formatProjectSize } from "@/lib/format-project-size";
import { AlertCircle, ArrowDown, ArrowUp, Check, CircleDot, Copy, ExternalLink, Folder, GitBranch, Github, LoaderCircle, Lock, RefreshCw, Search, Unlock, X } from "@/app/icons";

// Keep browser requests on the web app origin. The dev server proxies /api to
// the local filesystem service, which also makes the dashboard work in Codex
// previews where only the primary web port is exposed to the browser.
const API_BASE = "";
const RETRY_MS = 4_000;
type Filter = "all" | "attention" | "not_git" | "synced";
type ModalState = { type: "create" | "push"; project: ProjectRecord; trigger: HTMLElement | null } | null;
type GithubAuthState = { checked: boolean; cliAvailable: boolean; connected: boolean; login: string | null };
const filters: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All projects" }, { id: "attention", label: "Needs attention" },
  { id: "not_git", label: "Not Git yet" }, { id: "synced", label: "In sync" },
];

function isSynced(p: ProjectRecord) { return p.git.isRepository && p.github.state === "linked" && p.sync.state === "in_sync" && p.git.changeCount === 0 && p.git.statusAvailable; }
function relativeDate(value: string | null) {
  if (!value) return "No commits yet";
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return "Updated today"; if (days === 1) return "Updated yesterday";
  if (days < 30) return `Updated ${days} days ago`;
  return `Updated ${new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
function syncView(state: SyncState, ahead: number, behind: number) {
  if (state === "in_sync") return { label: "In sync", tone: "good", Icon: Check };
  if (state === "ahead") return { label: `${ahead} ahead`, tone: "warn", Icon: ArrowUp };
  if (state === "behind") return { label: `${behind} behind`, tone: "bad", Icon: ArrowDown };
  if (state === "diverged") return { label: "Diverged", tone: "bad", Icon: AlertCircle };
  if (state === "unpublished") return { label: "Not pushed", tone: "warn", Icon: ArrowUp };
  if (state === "no_commits") return { label: "No commits", tone: "warn", Icon: CircleDot };
  if (state === "no_remote") return { label: "Not linked", tone: "muted", Icon: Github };
  return { label: "Unavailable", tone: "muted", Icon: AlertCircle };
}

function Skeleton() { return <li className="project-row skeleton" aria-hidden="true"><div className="sk sk-title"/><div className="sk sk-size"/><div className="sk sk-state"/><div className="sk sk-action"/></li>; }

function ProjectRow({ project, githubAvailable, busy, enriching, onAction, onModal, onCopy }: {
  project: ProjectRecord; githubAvailable: boolean; busy: boolean;
  enriching?: boolean;
  onAction: (p: ProjectRecord, a: "init" | "link") => void;
  onModal: (m: NonNullable<ModalState>) => void; onCopy: (path: string) => void;
}) {
  const sync = syncView(project.sync.state, project.sync.ahead, project.sync.behind);
  const safePush = project.github.state === "linked" && !["behind", "diverged", "unavailable"].includes(project.sync.state) &&
    (project.git.changeCount > 0 || !project.git.statusAvailable || ["ahead", "unpublished", "no_commits"].includes(project.sync.state));
  const sizeText = project.size.status === "complete" ? formatProjectSize(project.size.bytes) : "Unavailable";
  const githubText = project.github.state === "linked" ? project.github.repository?.nameWithOwner || "Linked" : project.github.state === "matched" ? "Match found" : project.github.state === "unavailable" ? "CLI offline" : "No repository";
  return <li className="project-row" data-project={project.name}>
    <article>
      <div className="project-identity">
        <div className="project-index" aria-hidden="true">{project.name.slice(0, 2).toUpperCase()}</div>
        <div><h2>{project.name}</h2><button className="path-control" onClick={() => onCopy(project.pathLabel)} aria-label={`Copy full path ${project.pathLabel}`}><span>{project.pathLabel}</span><Copy size={13}/></button></div>
      </div>
      <div className={`size-readout ${project.size.status === "error" ? "size-error" : ""}`} aria-label={`Total size: ${sizeText}${project.size.status === "error" ? `. ${project.size.message}` : ""}`}>
        <span>TOTAL SIZE</span><strong>{sizeText}</strong>{project.size.status === "error" && <small>{project.size.message}</small>}
      </div>
      <div className="health-stack">
        <div><GitBranch size={14}/><span>Git</span><strong>{project.git.isRepository ? project.git.branch || "Detached HEAD" : "Not initialized"}</strong></div>
        <div><Github size={14}/><span>GitHub</span><strong>{githubText}</strong></div>
        <div className={sync.tone}><sync.Icon size={14}/><span>Sync</span><strong>{sync.label}</strong></div>
      </div>
      <div className="project-context">
        <p>{project.summary}</p>
        <div><span>{project.technologies.length ? project.technologies.join(" · ") : "General"}</span><span>{relativeDate(project.git.lastCommitAt || project.modifiedAt)}</span></div>
        {(project.git.changeCount > 0 || !project.git.statusAvailable) && <small>{project.git.statusAvailable ? `${project.git.changeCount} uncommitted ${project.git.changeCount === 1 ? "change" : "changes"}` : "Working tree scan timed out"}</small>}
        <details className="status-detail"><summary>Sync details</summary><p>{project.sync.detail}</p></details>
      </div>
      <div className="project-actions">
        {enriching ? <span className="remote-note">Checking project status…</span> : <>
        {project.github.state === "linked" && project.github.repository ? <a className="button quiet" href={project.github.repository.url} target="_blank" rel="noreferrer" aria-label={`Open ${project.github.repository.nameWithOwner} on GitHub`}><ExternalLink size={15}/> Open</a> : <button className="button quiet" onClick={() => onCopy(project.pathLabel)} aria-label={`Copy full path ${project.pathLabel}`}><Copy size={15}/> Copy</button>}
        {!project.git.isRepository && project.github.state !== "matched" && <button className="button secondary" disabled={busy} onClick={() => onAction(project,"init")}><GitBranch size={15}/> Initialize Git</button>}
        {project.github.state === "matched" && <button className="button primary" disabled={busy} onClick={() => onAction(project,"link")}>{busy ? <LoaderCircle className="spin" size={15}/> : <Github size={15}/>} {project.git.isRepository ? "Link repository" : "Initialize & link"}</button>}
        {project.github.state === "none" && githubAvailable && <button className="button primary" disabled={busy} onClick={(e) => onModal({type:"create",project,trigger:e.currentTarget})}><Github size={15}/> Create GitHub repo</button>}
        {safePush && <button className="button primary" disabled={busy} onClick={(e) => onModal({type:"push",project,trigger:e.currentTarget})}><ArrowUp size={15}/> {project.git.changeCount ? "Commit & push" : "Push to GitHub"}</button>}
        {isSynced(project) && <span className="up-to-date"><Check size={14}/> Up to date</span>}
        {project.github.state === "unavailable" && project.git.isRepository && <span className="remote-note">Remote actions unavailable</span>}
        </>}
      </div>
    </article>
  </li>;
}

function ActionModal({ modal, busy, onClose, onSubmit }: { modal: NonNullable<ModalState>; busy: boolean; onClose:()=>void; onSubmit:(p:Record<string,string>)=>void }) {
  const [visibility,setVisibility]=useState<"private"|"public">("private"); const [message,setMessage]=useState("Update project"); const dialog=useRef<HTMLElement>(null); const create=modal.type==="create";
  useEffect(()=>{ const first=dialog.current?.querySelector<HTMLElement>("input,button"); first?.focus(); const key=(e:KeyboardEvent)=>{ if(e.key==="Escape"&&!busy)onClose(); if(e.key==="Tab"&&dialog.current){const nodes=[...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];if(!nodes.length)return;const i=nodes.indexOf(document.activeElement as HTMLElement);if(e.shiftKey&&i===0){e.preventDefault();nodes.at(-1)?.focus();}else if(!e.shiftKey&&i===nodes.length-1){e.preventDefault();nodes[0].focus();}}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[busy,onClose]);
  return <div className="modal-backdrop" onMouseDown={()=>!busy&&onClose()}><section ref={dialog} className="action-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={e=>e.stopPropagation()}>
    <button className="modal-close" onClick={onClose} disabled={busy} aria-label="Close dialog"><X size={18}/></button><p className="modal-kicker">{modal.project.name}</p><h2 id="modal-title">{create?"Create a GitHub repository":"Commit and push changes"}</h2><p>{create?"Choose visibility. The new repository will be linked as origin.":`Stage and publish ${modal.project.git.changeCount || "local"} changes on the current branch.`}</p>
    {create?<div className="visibility-options" role="radiogroup" aria-label="Repository visibility">{(["private","public"] as const).map(v=><button key={v} role="radio" aria-checked={visibility===v} className={visibility===v?"selected":""} onClick={()=>setVisibility(v)}>{v==="private"?<Lock size={17}/>:<Unlock size={17}/>}<span><strong>{v[0].toUpperCase()+v.slice(1)}</strong><small>{v==="private"?"Only invited people":"Visible to everyone"}</small></span>{visibility===v&&<Check size={17}/>}</button>)}</div>:<label className="message-field"><span>Commit message</span><input value={message} maxLength={120} onChange={e=>setMessage(e.target.value)} placeholder="Describe this update"/><small>Obvious untracked secret files are blocked before staging.</small></label>}
    <div className="modal-actions"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy||(!create&&!message.trim())} onClick={()=>onSubmit(create?{visibility}:{message})}>{busy?<LoaderCircle className="spin" size={16}/>:create?<Github size={16}/>:<ArrowUp size={16}/>} {busy?"Working…":create?"Create repository":"Commit & push"}</button></div>
  </section></div>;
}

function RootPicker({ value, busy, error, onChange, onClose, onBrowse, onSave }: {
  value: string; busy: boolean; error: string | null;
  onChange: (value: string) => void; onClose: () => void;
  onBrowse: () => void; onSave: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
    <section className="action-modal root-picker" role="dialog" aria-modal="true" aria-labelledby="root-picker-title" onMouseDown={e => e.stopPropagation()}>
      <button className="modal-close" onClick={onClose} disabled={busy} aria-label="Close folder picker"><X size={18}/></button>
      <p className="modal-kicker">PROJECT SOURCE</p>
      <h2 id="root-picker-title">Choose a parent folder</h2>
      <p>Every direct folder inside this location will appear as a project. The choice is saved only on this computer.</p>
      <label className="message-field"><span>Folder path</span><input ref={input} value={value} onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && value.trim() && !busy) onSave(); }} placeholder="~/Documents"/><small>Use an absolute path or a path beginning with ~/.</small></label>
      {error && <p className="root-picker-error" role="alert">{error}</p>}
      <div className="modal-actions root-picker-actions"><button className="button quiet" onClick={onBrowse} disabled={busy}><Folder size={15}/> Browse…</button><span/><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={onSave} disabled={busy || !value.trim()}>{busy?<LoaderCircle className="spin" size={15}/>:<Check size={15}/>} Use this folder</button></div>
    </section>
  </div>;
}

function Onboarding({ rootLabel, auth, authCode, busy, error, onChooseFolder, onConnect, onDone }: {
  rootLabel: string; auth: GithubAuthState; authCode: string | null; busy: boolean; error: string | null;
  onChooseFolder: () => void; onConnect: () => void; onDone: () => void;
}) {
  return <div className="modal-backdrop onboarding-backdrop">
    <section className="action-modal onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <p className="modal-kicker">WELCOME TO PROJECT DECK</p>
      <h2 id="onboarding-title">Two quick checks, then you’re in.</h2>
      <p>Project Deck stays on this computer. Choose where your projects live, then optionally connect GitHub for remote status and repository actions.</p>
      <div className="onboarding-steps">
        <section><span className="step-number">1</span><div><strong>Project folder</strong><code>{rootLabel}</code><small>Each direct child folder becomes one project.</small></div><button className="button secondary" onClick={onChooseFolder}><Folder size={15}/> Change</button></section>
        <section><span className="step-number">2</span><div><strong>GitHub account</strong>{!auth.checked?<small>Checking GitHub CLI…</small>:auth.connected?<><span className="setup-success"><Check size={14}/> Connected as @{auth.login}</span><small>Remote status and repository actions are enabled.</small></>:!auth.cliAvailable?<><small>GitHub CLI is required for account connection.</small><a href="https://cli.github.com/" target="_blank" rel="noreferrer">Install GitHub CLI <ExternalLink size={12}/></a></>:authCode?<><span className="device-code">{authCode}</span><small>Enter this one-time code on GitHub’s secure device page.</small></>:<small>Connect to see remotes, sync state, and repository actions.</small>}</div>{auth.checked&&!auth.connected&&auth.cliAvailable&&(authCode?<a className="button primary" href="https://github.com/login/device" target="_blank" rel="noreferrer">Open GitHub <ExternalLink size={14}/></a>:<button className="button primary" disabled={busy} onClick={onConnect}>{busy?<LoaderCircle className="spin" size={15}/>:<Github size={15}/>} Connect</button>)}</section>
      </div>
      {error&&<p className="root-picker-error" role="alert">{error}</p>}
      <div className="onboarding-footer"><button className="button quiet" onClick={onDone}>{auth.connected?"Open dashboard":"Continue without GitHub"}</button></div>
    </section>
  </div>;
}

export function ProjectDashboard() {
  const [data,setData]=useState<ProjectScanResponse|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[query,setQuery]=useState(""),[filter,setFilter]=useState<Filter>("all"),[busyProject,setBusyProject]=useState<string|null>(null),[modal,setModal]=useState<ModalState>(null),[toast,setToast]=useState<string|null>(null),[retryPending,setRetryPending]=useState(false),[retryExhausted,setRetryExhausted]=useState(false);
  const [rootPickerOpen,setRootPickerOpen]=useState(false),[rootDraft,setRootDraft]=useState("~/Documents"),[rootBusy,setRootBusy]=useState(false),[rootError,setRootError]=useState<string|null>(null);
  const [onboardingOpen,setOnboardingOpen]=useState(false),[githubAuth,setGithubAuth]=useState<GithubAuthState>({checked:false,cliAvailable:false,connected:false,login:null}),[authCode,setAuthCode]=useState<string|null>(null),[authBusy,setAuthBusy]=useState(false),[authError,setAuthError]=useState<string|null>(null);
  const retryTimer=useRef<number|null>(null), requestActive=useRef(false), outageAttempts=useRef(0), loadRef=useRef<(refresh?:boolean,manual?:boolean)=>Promise<void>>(async()=>{});
  const refreshGithubAuth=useCallback(async()=>{try{const response=await fetch(`${API_BASE}/api/github/auth`,{cache:"no-store"});const result=await response.json() as Omit<GithubAuthState,"checked">;setGithubAuth({checked:true,...result});}catch{setGithubAuth({checked:true,cliAvailable:false,connected:false,login:null});}},[]);
  const loadProjects=useCallback(async(refresh=false,manual=false)=>{if(requestActive.current)return;if(manual){outageAttempts.current=0;if(retryTimer.current)window.clearTimeout(retryTimer.current);setRetryPending(false);setRetryExhausted(false);}requestActive.current=true;if(refresh)setRefreshing(true);else setLoading(true);setError(null);try{const res=await fetch(`${API_BASE}/api/projects${refresh?"?refresh=remote":""}`,{cache:"no-store"});if(!res.ok)throw new Error();setData(await res.json());outageAttempts.current=0;setRetryExhausted(false);}catch{setError("The local scanner is offline.");if(!data){outageAttempts.current+=1;if(outageAttempts.current===1){setRetryPending(true);retryTimer.current=window.setTimeout(()=>{setRetryPending(false);void loadRef.current(false);},RETRY_MS);}else setRetryExhausted(true);}}finally{requestActive.current=false;setLoading(false);setRefreshing(false);}},[data]);
  useEffect(()=>{loadRef.current=loadProjects;},[loadProjects]);
  useEffect(()=>{const initial=window.setTimeout(()=>void loadRef.current(false),0);return()=>{window.clearTimeout(initial);if(retryTimer.current)window.clearTimeout(retryTimer.current);};},[]);
  useEffect(()=>{const id=window.setTimeout(()=>{if(!window.localStorage.getItem("project-deck-onboarding-complete"))setOnboardingOpen(true);void refreshGithubAuth();},0);return()=>window.clearTimeout(id);},[refreshGithubAuth]);
  useEffect(()=>{if(!authCode||githubAuth.connected)return;const id=window.setInterval(()=>void refreshGithubAuth(),3000);return()=>window.clearInterval(id);},[authCode,githubAuth.connected,refreshGithubAuth]);
  useEffect(()=>{if(!authCode||!githubAuth.connected)return;const id=window.setTimeout(()=>{setAuthCode(null);setToast(`GitHub connected as @${githubAuth.login}.`);void loadRef.current(false,true);},0);return()=>window.clearTimeout(id);},[authCode,githubAuth.connected,githubAuth.login]);
  useEffect(()=>{if(!data?.enriching)return;const id=window.setInterval(()=>void loadRef.current(false),5000);return()=>window.clearInterval(id);},[data?.enriching]);
  useEffect(()=>{if(!toast)return;const id=window.setTimeout(()=>setToast(null),3600);return()=>clearTimeout(id);},[toast]);
  const action=useCallback(async(project:ProjectRecord,kind:"init"|"link"|"create-repo"|"push",payload:Record<string,string>={})=>{if(busyProject)return;setBusyProject(project.name);setError(null);try{const res=await fetch(`${API_BASE}/api/projects/${encodeURIComponent(project.name)}/${kind}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const result=await res.json() as ActionResponse|{ok:false;error:string};if(!res.ok||!result.ok)throw new Error("error" in result?result.error:"The action could not be completed.");setData(cur=>cur?{...cur,scannedAt:new Date().toISOString(),projects:cur.projects.map(p=>p.name===project.name?result.project:p)}:cur);setToast(result.message);modal?.trigger?.focus();setModal(null);}catch(e){setError(e instanceof Error?e.message:"The action could not be completed.");}finally{setBusyProject(null);}},[busyProject,modal]);
  const visible=useMemo(()=>{const needle=query.trim().toLowerCase();return(data?.projects||[]).filter(p=>(!needle||[p.name,p.summary,p.pathLabel,...p.technologies].join(" ").toLowerCase().includes(needle))&&(filter==="all"||(filter==="attention"&&!isSynced(p))||(filter==="not_git"&&!p.git.isRepository)||(filter==="synced"&&isSynced(p))));},[data,filter,query]);
  const counts=useMemo(()=>{const p=data?.projects||[];return{all:p.length,git:p.filter(x=>x.git.isRepository).length,github:p.filter(x=>x.github.state==="linked").length,attention:p.filter(x=>!isSynced(x)).length,totalBytes:p.reduce((n,x)=>n+(x.size.status==="complete"?x.size.bytes:0),0)};},[data]);
  const copy=async(path:string)=>{try{await navigator.clipboard.writeText(path);setToast("Project path copied.");}catch{setToast(`Copy this path: ${path}`);}};
  const closeModal=()=>{if(!modal)return;const trigger=modal.trigger;setModal(null);requestAnimationFrame(()=>trigger?.focus());};
  const chooseRoot=async(useNative:boolean)=>{setRootBusy(true);setRootError(null);try{const response=await fetch(`${API_BASE}/api/root${useNative?"/choose":""}`,{method:"POST",headers:{"Content-Type":"application/json"},body:useNative?undefined:JSON.stringify({path:rootDraft})});const result=await response.json() as ProjectScanResponse|{error:string};if(!response.ok||"error" in result)throw new Error("error" in result?result.error:"The folder could not be selected.");setData(result);setRootDraft(result.rootLabel);setRootPickerOpen(false);setToast(`Now scanning ${result.rootLabel}.`);}catch(e){setRootError(e instanceof Error?e.message:"The folder could not be selected.");}finally{setRootBusy(false);}};
  const connectGithub=async()=>{setAuthBusy(true);setAuthError(null);try{const response=await fetch(`${API_BASE}/api/github/auth`,{method:"POST"});const result=await response.json() as {code?:string|null;connected?:boolean;login?:string|null;error?:string};if(!response.ok||result.error)throw new Error(result.error||"GitHub sign-in could not start.");if(result.connected){await refreshGithubAuth();}else if(result.code){setAuthCode(result.code);}}catch(e){setAuthError(e instanceof Error?e.message:"GitHub sign-in could not start.");}finally{setAuthBusy(false);}};
  const finishOnboarding=()=>{window.localStorage.setItem("project-deck-onboarding-complete","1");setOnboardingOpen(false);};
  return <main className="dashboard-shell"><header className="topbar"><a className="brand" href="#top"><span className="brand-mark"><GitBranch size={15}/></span><span>PROJECT DECK</span></a><div className="topbar-tools"><span className={`connection ${githubAuth.connected?"online":""}`}><i/>{!data&&error?"Scanner offline":!githubAuth.checked?"Checking GitHub…":githubAuth.connected?`GitHub · @${githubAuth.login}`:"GitHub not connected"}</span><button className="button primary folder-button" onClick={()=>{setRootDraft(data?.rootLabel||"~/Documents");setRootError(null);setRootPickerOpen(true);}}><Folder size={15}/> Choose folder</button><button className="button refresh-button" disabled={refreshing} onClick={()=>void loadProjects(Boolean(data),true)}><RefreshCw className={refreshing?"spin":""} size={15}/>{refreshing?"Checking…":"Refresh"}</button></div></header>
  <div className="dashboard-content" id="top"><section className="hero"><div><p className="eyebrow">LOCAL SYSTEMS / 01</p><h1>Your projects, <em>measured.</em></h1><p>A precise inventory of every working folder in <code>{data?.rootLabel||"~/Documents"}</code>.</p></div></section>
  <section className="overview" aria-label="Project summary"><div><span>PROJECTS</span><strong>{loading&&!data?"—":counts.all}</strong><small>direct folders</small></div><div><span>ON DISK</span><strong>{loading&&!data?"—":formatProjectSize(counts.totalBytes)}</strong><small>measured total</small></div><div><span>GIT REPOSITORIES</span><strong>{loading&&!data?"—":counts.git}</strong><small>{githubAuth.connected?`${counts.github} linked to GitHub`:"local repositories detected"}</small></div><div className={counts.attention?"attention":""}><span>ATTENTION</span><strong>{loading&&!data?"—":counts.attention}</strong><small>{counts.attention?"records to review":"all systems clear"}</small></div></section>
  <section className="toolbar" aria-label="Project controls"><label className="search-field"><Search size={17}/><span className="sr-only">Search projects</span><input suppressHydrationWarning value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search name, path, summary, or technology"/>{query&&<button onClick={()=>setQuery("")} aria-label="Clear search"><X size={15}/></button>}</label><div className="filter-list" role="group" aria-label="Filter projects">{filters.map(f=><button key={f.id} aria-pressed={filter===f.id} onClick={()=>setFilter(f.id)}>{f.label}{f.id==="attention"&&counts.attention>0&&<span>{counts.attention}</span>}</button>)}</div></section>
  {error&&data&&<div className="error-banner" role="alert"><AlertCircle size={17}/><span>{error} Existing project data remains available.</span><button onClick={()=>setError(null)} aria-label="Dismiss error"><X size={15}/></button></div>}
  <section className="ledger" aria-busy={loading&&!data}><header><div><p>PROJECT INDEX</p><h2>{loading&&!data?"Reading the filesystem…":`${visible.length} of ${counts.all} records${data?.enriching?" · checking Git status…":""}`}</h2></div>{data&&<span>Checked {new Date(data.scannedAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</span>}</header><div className="ledger-columns" aria-hidden="true"><span>PROJECT</span><span>TOTAL SIZE</span><span>SYSTEM STATE</span><span>CONTEXT</span><span>NEXT ACTION</span></div><ul className="project-list">{loading&&!data?Array.from({length:5},(_,i)=><Skeleton key={i}/>):visible.map(p=><ProjectRow key={p.name} project={p} enriching={Boolean(data?.enriching)} githubAvailable={Boolean(data?.github.available)} busy={busyProject===p.name} onAction={(x,a)=>void action(x,a)} onModal={setModal} onCopy={path=>void copy(path)}/>)}</ul>
  {!loading&&!data&&error&&<div className="state-surface" role="status"><AlertCircle/><p className="eyebrow">LOCAL SERVICE / OFFLINE</p><h3>Scanner connection lost</h3><p>{retryPending?"Retrying automatically…":retryExhausted?"Still offline. Retry when the local scanner is available.":"The dashboard is waiting for the local scanner."}</p><button className="button secondary" onClick={()=>void loadProjects(false,true)}><RefreshCw size={15}/> Retry now</button></div>}
  {!loading&&data&&data.projects.length===0&&<div className="state-surface"><Folder/><p className="eyebrow">ROOT / EMPTY</p><h3>No project folders found</h3><p><code>{data.rootLabel}</code> is available, but it contains no direct project folders.</p></div>}
  {!loading&&data&&data.projects.length>0&&visible.length===0&&<div className="state-surface"><Search/><p className="eyebrow">VIEW / EMPTY</p><h3>No projects match this view</h3><p>Change the current search or filter to return to the ledger.</p><button className="button secondary" onClick={()=>{setFilter("all");setQuery("");}}>Show every project</button></div>}</section></div>
  <div className="sr-only" role="status" aria-live="polite">{loading?"Scanning project folders":refreshing?"Checking project sizes and GitHub status":toast||""}</div>{toast&&<div className="toast" role="status"><Check size={15}/>{toast}</div>}{modal&&<ActionModal modal={modal} busy={busyProject===modal.project.name} onClose={closeModal} onSubmit={p=>void action(modal.project,modal.type==="create"?"create-repo":"push",p)}/>} {onboardingOpen&&<Onboarding rootLabel={data?.rootLabel||"~/Documents"} auth={githubAuth} authCode={authCode} busy={authBusy} error={authError} onChooseFolder={()=>{setRootDraft(data?.rootLabel||"~/Documents");setRootError(null);setRootPickerOpen(true);}} onConnect={()=>void connectGithub()} onDone={finishOnboarding}/>} {rootPickerOpen&&<RootPicker value={rootDraft} busy={rootBusy} error={rootError} onChange={setRootDraft} onClose={()=>!rootBusy&&setRootPickerOpen(false)} onBrowse={()=>void chooseRoot(true)} onSave={()=>void chooseRoot(false)}/>}</main>;
}
