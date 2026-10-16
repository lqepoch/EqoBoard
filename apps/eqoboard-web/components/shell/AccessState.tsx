type AccessStateProps = {
  title: string;
  detail: string;
  state?: "restricted" | "unavailable";
};

export function AccessState({ title, detail, state = "restricted" }: AccessStateProps) {
  return (
    <section
      aria-live="polite"
      className="eq-access-state"
      data-state={state}
      data-testid="access-state"
    >
      <div aria-hidden="true" className="eq-access-state__mark">
        {state === "unavailable" ? "!" : "i"}
      </div>
      <div className="eq-access-state__body">
        <h1 className="eq-access-state__title">{title}</h1>
        <p className="eq-access-state__detail">{detail}</p>
      </div>
    </section>
  );
}
