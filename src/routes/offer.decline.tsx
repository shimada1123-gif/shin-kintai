import { createFileRoute } from '@tanstack/react-router'
import { OfferLanding } from '@/components/OfferLanding'

/** オファー拒否の着地（メールリンク・認証不要）。?t=<生トークン> */
export const Route = createFileRoute('/offer/decline')({
  validateSearch: (search: Record<string, unknown>): { t?: string } => ({
    t: typeof search.t === 'string' && search.t ? search.t : undefined,
  }),
  component: OfferDeclinePage,
})

function OfferDeclinePage() {
  const { t } = Route.useSearch()
  return <OfferLanding action="decline" token={t} />
}
