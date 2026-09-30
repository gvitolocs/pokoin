/** Hold-tray rendering budget (cart + Desktop popovers).
 *
 * Full leftover scans are ~630x880; a dropped artist used to mount hundreds of
 * them in a small popover (hundreds of MB decoded) and the tab died to a black
 * screen. Trays paint small homepage thumbs past a handful of cards and mount
 * only the first TRAY_VISIBLE until the viewer asks for the rest. */
export const TRAY_VISIBLE = 120;
export const TRAY_FULL_ART_MAX = 4;
