import { createFileRoute } from '@tanstack/react-router'
import { OfferLanding } from '@/components/OfferLanding'

/** オファー承諾の着地（メールリンク・認証不要）。?t=<生トークン> */
export const Route = createFileRoute('/offer/accept')({
  validateSearch: (search: Record<string, unknown>): { t?: string } => ({
    t: typeof search.t === 'string' && search.t ? search.t : undefined,
  }),
  component: OfferAcceptPage,
})

function OfferAcceptPage() {
  const { t } = Route.useSearch()
  return <OfferLanding action="accept" token={t} />
}
