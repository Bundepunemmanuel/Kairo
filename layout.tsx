import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Kairo — Find Customers Already Looking For You',
  description: 'Kairo scans Reddit 24/7 and surfaces people actively looking for products like yours. Stop searching manually. Start waking up to customers.',
  openGraph: {
    title: 'Kairo — Find Customers Already Looking For You',
    description: 'Stop searching Reddit manually. Kairo finds buyers, scores their intent, and drafts your reply — before your competitors even see the post.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  )
}
