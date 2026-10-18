/**
 * Globe data colours as plain hex, with no three.js import, so the eager DOM layer (the map key)
 * can share them with the lazy WebGL layer. Values are DESIGN.md's delayed and ontime tokens.
 */
export const AMBER_HEX = '#e8a54b';
export const BLUE_HEX = '#7c9bd1';
/** A beacon near the national delay rate: warm ink, not a data colour. */
export const NEUTRAL_HEX = '#d8d2c4';
/** A selected airport's destinations, which carry no delay figure. */
export const NETWORK_HEX = '#e6dfcf';
