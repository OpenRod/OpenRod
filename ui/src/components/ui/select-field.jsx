import * as React from 'react'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

// Keep declarative option labels while rendering the shared shadcn select.
export function SelectField({ children, value, onChange, className, disabled, ...props }) {
  const items = React.Children.toArray(children).map((child) => ({
    value: child.props.value ?? child.props.children,
    label: child.props.children,
    disabled: child.props.disabled,
  }))
  return <Select items={items} value={value} disabled={disabled} onValueChange={(next) => onChange?.({ target: { value: next } })}>
    <SelectTrigger className={className} {...props}><SelectValue /></SelectTrigger>
    <SelectContent align="start">{items.map((item) => <SelectItem className="text-xs" key={item.value} value={item.value} disabled={item.disabled}>{item.label}</SelectItem>)}</SelectContent>
  </Select>
}
