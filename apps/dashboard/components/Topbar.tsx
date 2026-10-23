import { CircleCheck, ListChecks, LogIn, LogOut, Plug } from 'lucide-react';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

/** GitHub's mark (Octicons mark-github, MIT). Lucide no longer ships brand logos. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const;

export function Topbar({
  loggedIn,
  allowed,
  current,
  githubLinked = false,
}: {
  loggedIn: boolean;
  allowed: boolean;
  current?: 'case-study' | 'review';
  githubLinked?: boolean;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="/" aria-label="Nightshift, case study home">
          <Logo size={22} />
          <span className="brand-name">Nightshift</span>
          <span className="brand-sep" aria-hidden="true">
            /
          </span>
          <span className="brand-crumb">{current === 'review' ? 'Review' : 'Case study'}</span>
        </a>
        <nav className="topnav" aria-label="Main">
          {allowed && (
            <a className={`nav-link ${current === 'review' ? 'is-current' : ''}`} href="/review" aria-current={current === 'review' ? 'page' : undefined}>
              <ListChecks {...ICON} />
              <span className="nav-label">Review</span>
            </a>
          )}
          {allowed &&
            (githubLinked ? (
              <span className="nav-status" title="GitHub is connected through Auth0 Token Vault; Post can reach your repository">
                <CircleCheck {...ICON} />
                <span className="nav-label">GitHub connected</span>
              </span>
            ) : (
              <a className="nav-link" href="/auth/connect?connection=github&returnTo=/review" title="Connect GitHub through Auth0 Token Vault (needed to post approved replies)">
                <Plug {...ICON} />
                <span className="nav-label">Connect GitHub</span>
              </a>
            ))}
          <span className="nav-divider" aria-hidden="true" />
          <a className="icon-btn" href="https://github.com/AbdulWasih05/nightshift" aria-label="Repository on GitHub" title="Repository on GitHub">
            <GitHubMark />
          </a>
          <ThemeToggle />
          {loggedIn ? (
            <a className="btn btn-sm" href="/auth/logout">
              <LogOut {...ICON} />
              <span className="nav-label">Log out</span>
            </a>
          ) : (
            <a className="btn btn-sm primary" href="/auth/login?returnTo=/review">
              <LogIn {...ICON} />
              <span>Maintainer login</span>
            </a>
          )}
        </nav>
      </div>
    </header>
  );
}
