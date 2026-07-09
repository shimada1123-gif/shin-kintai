import { createFileRoute } from '@tanstack/react-router'
import { Placeholder } from '@/components/AppShell'

export const Route = createFileRoute('/_authed/attendance')({
  component: () => <Placeholder title="勤怠" />,
})
