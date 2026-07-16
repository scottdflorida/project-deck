declare module "lucide-react/dist/esm/icons/*.mjs" {
  import type {
    ForwardRefExoticComponent,
    RefAttributes,
    SVGProps,
  } from "react";

  type IconProps = SVGProps<SVGSVGElement> & {
    absoluteStrokeWidth?: boolean;
    size?: number | string;
  };

  const Icon: ForwardRefExoticComponent<
    Omit<IconProps, "ref"> & RefAttributes<SVGSVGElement>
  >;

  export default Icon;
}
