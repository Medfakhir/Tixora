import type { Metadata } from 'next'
import { LegalContent } from '@/components/store/legal-content'
import { getGeneral } from '@/lib/settings/service'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Terms and conditions',
}

export default async function TermsPage() {
  const general = await getGeneral()

  const fallback = `Tickets are sold by ${general.storeName}. By placing an order you agree to these terms.

All prices are shown at checkout and charged in the currency displayed. Payment is handled by PayPal. Your order is confirmed once payment is captured.

Tickets are delivered as PDF files to the email address provided at checkout. Please check your spam folder if they do not arrive. Each ticket is valid only for the date, time and event shown on it, and may not be resold unless the law allows it.

If an event is cancelled or rescheduled, contact ${general.supportEmail} and we will help with the options available to you.`

  const body = general.termsAndConditions.trim() || fallback

  return <LegalContent title="Terms and conditions" body={body} supportEmail={general.supportEmail} />
}
