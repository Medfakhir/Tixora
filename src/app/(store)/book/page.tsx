import { redirect } from 'next/navigation'

/** Kept as a stable booking URL (book.visitbadipalace.com/book) for campaigns. */
export default function BookPage() {
  redirect('/#book')
}
