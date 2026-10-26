import Sidebar from '@/components/layout/Sidebar'

export default function EmployeesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#FFFFFF] text-[#0B1220]">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">{children}</main>
    </div>
  )
}
