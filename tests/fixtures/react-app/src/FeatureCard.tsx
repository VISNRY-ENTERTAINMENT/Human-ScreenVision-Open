interface FeatureCardProps {
  title: string
  description: string
}

export function FeatureCard({ title, description }: FeatureCardProps) {
  return (
    <article className="feature-card" data-testid="feature-card">
      <h3>{title}</h3>
      <p>{description}</p>
    </article>
  )
}
