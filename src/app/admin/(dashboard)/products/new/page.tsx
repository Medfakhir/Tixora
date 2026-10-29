import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/guards'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { ProductForm } from '@/components/admin/product-form'
import { PageHeader } from '@/components/admin/page-primitives'
import { buttonVariants } from '@/components/ui/button'

export const metadata = { title: 'New product' }

export default async function NewProductPage() {
  await requireAdminPage()
  const [categories, general] = await Promise.all([
    prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
    getGeneral(),
  ])

  return (
    <div className="grid gap-6">
      <PageHeader
        title="New product"
        description="Create the product first; ticket PDFs are uploaded from the inventory workspace once it exists."
        actions={
          <Link href="/admin/products" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Back to products
          </Link>
        }
      />
      <ProductForm categories={categories} defaultCurrency={general.defaultCurrency} />
    </div>
  )
}
