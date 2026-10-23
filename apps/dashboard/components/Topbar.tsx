export function Topbar({ loggedIn, allowed }: { loggedIn: boolean; allowed: boolean }) {
  return (
    <div className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="/">
          Nightshift<span>case study</span>
        </a>
        <nav className="topnav" aria-label="Main">
          <a className="btn quiet" href="https://github.com/AbdulWasih05/nightshift">Repository</a>
          {allowed && (
            <>
              <a className="btn quiet" href="/review">Review</a>
              <a className="btn" href="/auth/connect?connection=github&returnTo=/review">Connect GitHub</a>
            </>
          )}
          {loggedIn ? (
            <a className="btn" href="/auth/logout">Log out</a>
          ) : (
            <a className="btn primary" href="/auth/login?returnTo=/review">Maintainer login</a>
          )}
        </nav>
      </div>
    </div>
  );
}
