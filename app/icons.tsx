import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

export const AlertCircle = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7.8v4.8"/><path d="M12 16.2h.01"/></Icon>;
export const ArrowDown = (props: IconProps) => <Icon {...props}><path d="M12 4v16M6.5 14.5 12 20l5.5-5.5"/></Icon>;
export const ArrowUp = (props: IconProps) => <Icon {...props}><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5"/></Icon>;
export const Check = (props: IconProps) => <Icon {...props}><path d="m5 12.5 4.2 4.2L19 7"/></Icon>;
export const CircleDot = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></Icon>;
export const Copy = (props: IconProps) => <Icon {...props}><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></Icon>;
export const ExternalLink = (props: IconProps) => <Icon {...props}><path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></Icon>;
export const Folder = (props: IconProps) => <Icon {...props}><path d="M3.5 7.5h6l2-2h4.8a2.2 2.2 0 0 1 2.2 2.2v8.8a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/></Icon>;
export const GitBranch = (props: IconProps) => <Icon {...props}><circle cx="7" cy="5" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 10h3a5 5 0 0 0 5-5"/></Icon>;
export const Github = (props: IconProps) => <Icon {...props}><path d="M15 21v-3.8c0-1 .1-1.5-.5-2.1 2.8-.3 5.7-1.4 5.7-6.3A4.9 4.9 0 0 0 19 5.4 4.6 4.6 0 0 0 18.9 2S17.8 1.7 15 3.3a13 13 0 0 0-6 0C6.2 1.7 5.1 2 5.1 2A4.6 4.6 0 0 0 5 5.4a4.9 4.9 0 0 0-1.2 3.4c0 4.9 2.9 6 5.7 6.3-.5.5-.6 1.1-.5 2.1V21"/><path d="M9 18c-2.4 1.1-3-1-4-1.5"/></Icon>;
export const LoaderCircle = (props: IconProps) => <Icon {...props}><path d="M21 12a9 9 0 1 1-6.2-8.6"/></Icon>;
export const Lock = (props: IconProps) => <Icon {...props}><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3"/></Icon>;
export const Minus = (props: IconProps) => <Icon {...props}><path d="M5 12h14"/></Icon>;
export const MoreHorizontal = (props: IconProps) => <Icon {...props}><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></Icon>;
export const Pencil = (props: IconProps) => <Icon {...props}><path d="m4 20 4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z"/><path d="m13.8 7.4 3 3"/></Icon>;
export const RefreshCw = (props: IconProps) => <Icon {...props}><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8.5A7 7 0 0 1 18.7 7L20 12M4 12l1.3 5a7 7 0 0 0 12.6-1.5"/></Icon>;
export const Search = (props: IconProps) => <Icon {...props}><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4 4"/></Icon>;
export const Unlock = (props: IconProps) => <Icon {...props}><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8.5 10V7a3.5 3.5 0 0 1 6.6-1.6"/></Icon>;
export const X = (props: IconProps) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>;
