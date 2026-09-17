export function NavBar() {
  return (
    <nav data-testid="navbar" className="navbar">
      <div className="nav-logo">Acme</div>
      <ul className="nav-links">
        <li><a href="/features">Features</a></li>
        <li><a href="/pricing">Pricing</a></li>
        <li><a href="/docs">Docs</a></li>
      </ul>
      <button className="nav-login" aria-label="login">Login</button>
      <button className="hamburger" aria-label="menu" style={{display:'none'}}>☰</button>
    </nav>
  )
}
