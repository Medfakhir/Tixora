import Link from 'next/link'
import { Button } from '@/components/ui/button'

export function LegalContent({
  title,
  body,
  supportEmail,
}: {
  title: string
  body: string
  supportEmail: string
}) {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
      <div className="grid gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="text-sm text-muted-foreground">
          Questions?{' '}
          <a href={`mailto:${supportEmail}`} className="underline underline-offset-4 hover:text-foreground">
            {supportEmail}
          </a>
        </p>
      </div>

      <article className="mt-8 grid gap-4 text-sm leading-relaxed text-foreground/90 sm:text-base">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </article>

      <div className="mt-10 border-t pt-6">
        <Button variant="outline" render={<Link href="/products" />}>
          Back to tickets
        </Button>
      </div>
    </div>
  )
}
