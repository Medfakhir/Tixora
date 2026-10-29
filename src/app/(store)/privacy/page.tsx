import type { Metadata } from 'next'
import { LegalContent } from '@/components/store/legal-content'
import { getGeneral } from '@/lib/settings/service'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Privacy policy',
}

export default async function PrivacyPage() {
  const general = await getGeneral()

  const fallback = `This store is operated by ${general.storeName}. We collect the name, email address and optional phone number you provide at checkout, together with the details of your order, so we can process payment and deliver your tickets.

Payments are processed by PayPal. We do not receive or store your full payment details. Ticket files and order records are kept only as long as needed to provide your tickets, meet legal obligations and handle support requests.

We use your email address to send your tickets and order updates. We do not sell your personal information. To access, correct or delete the details we hold about you, contact us at ${general.supportEmail}.`

  const body = general.privacyPolicy.trim() || fallback

  return <LegalContent title="Privacy policy" body={body} supportEmail={general.supportEmail} />
}
