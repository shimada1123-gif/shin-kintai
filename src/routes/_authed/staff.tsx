import { createFileRoute } from '@tanstack/react-router'
import { Placeholder } from '@/components/AppShell'

export const Route = createFileRoute('/_authed/staff')({
  component: () => <Placeholder title="スタッフ" />,
})
