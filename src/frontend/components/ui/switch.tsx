import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from 'cn';

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return <SwitchPrimitive.Root data-slot="switch"
    className={cn('peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary', className)}
    {...props}>
    <SwitchPrimitive.Thumb data-slot="switch-thumb"
      className="pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5 motion-reduce:transition-none" />
  </SwitchPrimitive.Root>;
}

export { Switch };
