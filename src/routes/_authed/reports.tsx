import { createFileRoute } from '@tanstack/react-router'
import { Placeholder } from '@/components/AppShell'

export const Route = createFileRoute('/_authed/reports')({
  component: () => <Placeholder title="レポート" />,
})
