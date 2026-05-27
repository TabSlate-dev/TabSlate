import { BookMarked } from "lucide-react";
import { LoginForm } from "@/components/login-form";
import { LanguageSelector } from "@/components/language-selector";

export function AuthPage() {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Left: form */}
      <div className="flex flex-col gap-4 p-6 md:p-10 relative">
        <div className="absolute top-6 right-6 md:top-10 md:right-10 z-10">
          <LanguageSelector />
        </div>
        <div className="flex justify-center gap-2 md:justify-start">
          <div className="flex items-center gap-2 font-medium">
            <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <BookMarked className="size-4" />
            </div>
            TabSlate
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <LoginForm />
          </div>
        </div>
      </div>

      {/* Right: decorative panel (hidden on mobile) */}
      <div className="relative hidden bg-muted lg:block">
        <div className="absolute inset-0 bg-linear-to-br from-primary/20 via-muted to-muted-foreground/10" />
      </div>
    </div>
  );
}
