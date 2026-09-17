import { FeatureCard } from './FeatureCard'

const FEATURES = [
  { title: 'Code Index', description: 'Parses your codebase into a semantic map.' },
  { title: 'Semantic Targeting', description: 'Find elements by what they are, not by CSS.' },
  { title: 'Verification', description: 'Structural pass/fail against expected rendering.' },
]

export function FeaturesSection() {
  return (
    <section data-testid="features" className="features">
      <h2>Features</h2>
      <div className="feature-grid">
        {FEATURES.map((f) => (
          <FeatureCard key={f.title} title={f.title} description={f.description} />
        ))}
      </div>
    </section>
  )
}
