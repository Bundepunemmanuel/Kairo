import { KairoLogo } from './Nav'

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div>
          <div className="footer-logo"><KairoLogo size={20} />Kairo</div>
          <p className="footer-tagline">Customer acquisition for solo founders.</p>
        </div>
        <div className="footer-links">
          <a href="https://subscan-omega.vercel.app" target="_blank" rel="noopener noreferrer">SubScan</a>
          <a href="/#pricing">Pricing</a>
          <a href="/#how-it-works">How It Works</a>
        </div>
      </div>
      <div className="footer-bottom">© 2026 Kairo. Built for solo founders.</div>
    </footer>
  )
}
