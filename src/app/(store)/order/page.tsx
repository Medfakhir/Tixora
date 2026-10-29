import Link from 'next/link'
import { OrderLookupForm } from '@/components/store/order-lookup-form'

export const metadata = { title: 'Find your order' }
export const dynamic = 'force-dynamic'

export default function OrderLookupPage() {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-12">
      <div className="grid gap-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Find your order</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Use the order reference from your receipt and the email address you booked with.
          </p>
        </div>

        <OrderLookupForm />

        <p className="text-sm text-muted-foreground">
          Looking for tickets?{' '}
          <Link href="/products" className="underline underline-offset-4 hover:text-foreground">
            Browse the store
          </Link>
          .
        </p>
      </div>
    </div>
  )
}
