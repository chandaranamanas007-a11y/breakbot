import './globals.css'

export const metadata = {
  title: 'BreakerBot Security',
  description: 'IoT Smart Access Control Dashboard',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
