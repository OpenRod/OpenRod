import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EgressView } from "@/components/egress-view"
import { IngressView } from "@/components/ingress-view"

// Egress and ingress are two tabs of one page. Each tab keeps its own
// address (#egress, #ingress), so links from other pages land on the right one.
export function NetworkView({ tab, onNavigate }) {
  return (
    <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col">
      <Tabs value={tab} onValueChange={onNavigate} className="shrink-0 gap-0">
        <div className="border-b bg-card px-4 sm:px-8">
          <TabsList variant="line" className="h-11! gap-5 p-0">
            <TabsTrigger value="egress" className="h-full px-0 text-xs after:bottom-0!">Egress</TabsTrigger>
            <TabsTrigger value="ingress" className="h-full px-0 text-xs after:bottom-0!">Ingress</TabsTrigger>
          </TabsList>
        </div>
      </Tabs>
      <div className="min-h-0 flex-1">
        {tab === "egress" ? <EgressView onNavigate={onNavigate} /> : <IngressView />}
      </div>
    </div>
  )
}
