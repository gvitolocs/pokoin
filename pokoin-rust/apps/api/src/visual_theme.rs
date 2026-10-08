use serde_json::{json,Value};
use pokoin_catalog::card::{text,number};
fn rgb(hex:&str)->Option<[f64;3]> {
 if hex.len()!=7 || !hex.starts_with('#'){return None}
 Some([u8::from_str_radix(&hex[1..3],16).ok()? as f64,u8::from_str_radix(&hex[3..5],16).ok()? as f64,u8::from_str_radix(&hex[5..7],16).ok()? as f64])
}
fn lin(v:f64)->f64{let v=v/255.;if v<=0.04045{v/12.92}else{((v+0.055)/1.055).powf(2.4)}}
fn dot(m:[[f64;3];3],v:[f64;3])->[f64;3]{m.map(|r|r[0]*v[0]+r[1]*v[1]+r[2]*v[2])}
fn hex(l:f64,c:f64,h:f64)->String{
 let rad=h.to_radians();let p=dot([[1.,0.3963377774,0.2158037573],[1.,-0.1055613458,-0.0638541728],[1.,-0.0894841775,-1.291485548]],[l,rad.cos()*c,rad.sin()*c]).map(|v|v*v*v);
 let rgb=dot([[4.0767416621,-3.3077115913,0.2309699292],[-1.2684380046,2.6097574011,-0.3413193965],[-0.0041960863,-0.7034186147,1.707614701]],p).map(|v|((if v<=0.0031308{v*12.92}else{1.055*v.powf(1./2.4)-0.055})*255.).round().clamp(0.,255.) as u8);
 format!("#{:02x}{:02x}{:02x}",rgb[0],rgb[1],rgb[2])
}
fn contrast_white(hex:&str)->f64{let v=rgb(hex).unwrap().map(lin);1.05/(0.2126*v[0]+0.7152*v[1]+0.0722*v[2]+0.05)}
pub fn visual_theme(row:&Value,shade:&str,identity:&str)->Value{
 let Some(v)=rgb(shade) else{return Value::Null};
 let fields=[("background","background"),("surface","surface"),("surfaceRaised","surface_raised"),("hero","hero"),("heroBorder","hero_border"),("border","border"),("tint","tint")];
 if text(row,&["version"])=="v1" && !identity.is_empty() && text(row,&["artwork_identity","artworkIdentity"])==identity && fields.iter().all(|(_,key)|rgb(&text(row,&[key])).is_some()){
  let mut r=json!({"version":"v1","artworkShade":shade.to_lowercase(),"artworkIdentity":identity,"hue":number(row,&["hue"]),"chroma":number(row,&["chroma"])});
  for (key,column) in fields{r[key]=json!(text(row,&[column]).to_lowercase())}return r
 }
 let lms=dot([[0.4122214708,0.5363325363,0.0514459929],[0.2119034982,0.6806995451,0.1073969566],[0.0883024619,0.2817188376,0.6299787005]],v.map(lin)).map(f64::cbrt);
 let [l,a,b]=dot([[0.2104542553,0.793617785,-0.0040720468],[1.9779984951,-2.428592205,0.4505937099],[0.0259040371,0.7827717662,-0.808675766]],lms);
 let c=(a*a+b*b).sqrt();let neutral=c<0.02;
 let h=if neutral{0.}else{b.atan2(a).to_degrees().rem_euclid(360.)};
 let kept=if neutral{0.}else{(c*2.2).clamp(0.055,0.11)};
 let background_l=(l*0.5).clamp(0.15,0.2);let surface_l=(background_l+0.04).clamp(0.19,0.24);
 let mut hero_l=(l+0.04).clamp(0.34,0.52);let hero_c=if neutral{0.}else{(c*1.35).min(0.115)};
 for _ in 0..8{if contrast_white(&hex(hero_l,hero_c,h))>=4.5{break}hero_l-=0.025}
 json!({"version":"v1","artworkShade":shade.to_lowercase(),"artworkIdentity":identity,
 "hue":(h*1000.).round()/1000.,"chroma":(c*1000.).round()/1000.,
 "background":hex(background_l,kept,h),"surface":hex(surface_l,(kept*1.15).min(0.12),h),
 "surfaceRaised":hex((surface_l+0.018).clamp(0.21,0.255),(kept*1.2).min(0.125),h),
 "hero":hex(hero_l,hero_c,h),"heroBorder":hex(0.45,if neutral{0.}else{(c*0.9).min(0.09)},h),
 "border":hex(0.34,if neutral{0.}else{(c*0.5).min(0.035)},h),
 "tint":hex((hero_l+0.05).clamp(0.4,0.55),if neutral{0.}else{c.min(0.075)},h)})
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn missing_artwork_stays_neutral(){assert_eq!(visual_theme(&Value::Null,"",""),Value::Null)}
 #[test]fn stale_equal_shade_artwork_is_rederived(){
 let row=json!({"version":"v1","artwork_identity":"old","background":"#ff0000","surface":"#ff0000","surface_raised":"#ff0000","hero":"#ff0000","hero_border":"#ff0000","border":"#ff0000","tint":"#ff0000"});
 let t=visual_theme(&row,"#c4c4c4","new");
 assert_eq!(t["hue"],0.);assert_eq!(t["artworkIdentity"],"new");assert_ne!(t["background"],"#ff0000");
 assert!(contrast_white(t["hero"].as_str().unwrap())>=4.5);
 }
}

#[cfg(test)]mod reference_tests{
 use super::*;
 #[test]fn theme_matches_authoritative_color_matrix(){
  let cases:Vec<Value>=serde_json::from_str(include_str!("../fixtures/theme-contract.json")).unwrap();
  for case in cases{let mut actual=visual_theme(&Value::Null,case["shade"].as_str().unwrap(),"artwork-1");let mut expected=case["expected"].clone(); for key in ["hue","chroma"] { actual[key]=json!(actual[key].as_f64().unwrap());expected[key]=json!(expected[key].as_f64().unwrap()); } assert_eq!(actual,expected)}
 }
}

pub fn pack_visual_theme(theme:&Value)->Option<String>{
 if theme["version"]!="v1"{return None}
 let mut pack="v1".to_owned();
 for field in ["background","surface","surfaceRaised","hero","heroBorder","border","tint"]{
  let hex=theme[field].as_str()?;
  if hex.len()!=7 || !hex.starts_with('#') || !hex[1..].bytes().all(|b|b.is_ascii_hexdigit()){return None}
  pack.push_str(&hex[1..].to_ascii_lowercase());
 }
 Some(pack)
}
