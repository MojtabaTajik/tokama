// Line icons: the rail's (18 px) and the small ones of sidebar rows and headers (12 px), stroke in the current colour. Decorative: every button
// that shows one has its own label.
import type { ReactNode } from "react";

function Icon({ children, size = 18 }: { readonly children: ReactNode; readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const PanelIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Icon>
);

export const BoardIcon = () => (
  <Icon>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="10" rx="1" />
    <rect x="17" y="4" width="4" height="13" rx="1" />
  </Icon>
);

export const InboxIcon = () => (
  <Icon>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" />
  </Icon>
);

export const InsightsIcon = () => (
  <Icon>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-4 3 3 5-6" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
  </Icon>
);

export const AttentionIcon = () => (
  <Icon>
    <path d="M12 3 2 20h20z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
);

export const UserIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </Icon>
);

export const RepoIcon = ({ size = 12 }: { readonly size?: number }) => (
  <Icon size={size}>
    <circle cx="6" cy="5" r="2.5" />
    <circle cx="6" cy="19" r="2.5" />
    <circle cx="18" cy="7" r="2.5" />
    <path d="M6 7.5v9M18 9.5c0 5-7 4-11.5 7.5" />
  </Icon>
);

export const AllWorkIcon = ({ size = 12 }: { readonly size?: number }) => (
  <Icon size={size}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
);

/** ⤢: open in the full view. */
export const ExpandIcon = ({ size = 15 }: { readonly size?: number }) => (
  <Icon size={size}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </Icon>
);

/** ⤡: close the full view. */
export const CollapseIcon = ({ size = 16 }: { readonly size?: number }) => (
  <Icon size={size}>
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </Icon>
);
