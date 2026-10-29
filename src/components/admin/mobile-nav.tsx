'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { SidebarNav } from './sidebar-nav'
import type { AdminRole } from '@prisma/client'

export function MobileNav({ role }: { role: AdminRole }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="ghost" size="icon" className="text-sidebar-foreground lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
        <Menu />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger className="hidden" aria-hidden />
        <SheetContent side="left" className="w-60 bg-sidebar p-0 text-sidebar-foreground ring-0 sm:max-w-60">
          <SheetHeader className="border-b border-sidebar-border">
            <SheetTitle className="text-sidebar-foreground">Tixora</SheetTitle>
            <SheetDescription className="sr-only">Admin navigation</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SidebarNav role={role} />
          </div>
          <div className="border-t border-sidebar-border p-4">
            <Link href="/" className="text-xs text-sidebar-foreground/70 underline" onClick={() => setOpen(false)}>
              Open storefront
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
