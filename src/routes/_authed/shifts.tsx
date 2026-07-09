import { createFileRoute } from '@tanstack/react-router'
import { Placeholder } from '@/components/AppShell'

export const Route = createFileRoute('/_authed/shifts')({
  component: () => <Placeholder title="シフト" />,
})
