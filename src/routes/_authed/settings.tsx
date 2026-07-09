import { createFileRoute } from '@tanstack/react-router'
import { Placeholder } from '@/components/AppShell'

export const Route = createFileRoute('/_authed/settings')({
  component: () => <Placeholder title="設定" />,
})
