import { NavBar } from './NavBar'
import { HeroSection } from './HeroSection'
import { FeaturesSection } from './FeaturesSection'
import { Footer } from './Footer'

export default function App() {
  return (
    <div className="app-root" id="app">
      <NavBar />
      <main className="app-main">
        <HeroSection />
        <FeaturesSection />
      </main>
      <Footer />
    </div>
  )
}
