import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EgressView } from "@/components/egress-view"
import { IngressView } from "@/components/ingress-view"

// Egress and ingress are two tabs of one page. Each tab keeps its own
// address (#egress, #ingress), so links from other pages land on the right one.
// Inactive panels unmount, so only the open tab loads and polls.
export function NetworkView({ tab, onNavigate }) {
  return (
    <Tabs value={tab} onValueChange={onNavigate} className="h-[calc(100svh-3.5rem)] min-h-0 gap-0">
      <div className="shrink-0 border-b bg-card px-4 sm:px-8">
        <TabsList variant="line" className="h-11! gap-5 p-0">
          <TabsTrigger value="egress" className="h-full px-0 text-xs after:bottom-0!">Egress</TabsTrigger>
          <TabsTrigger value="ingress" className="h-full px-0 text-xs after:bottom-0!">Ingress</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="egress" className="min-h-0"><EgressView onNavigate={onNavigate} /></TabsContent>
      <TabsContent value="ingress" className="min-h-0"><IngressView /></TabsContent>
    </Tabs>
  )
}
