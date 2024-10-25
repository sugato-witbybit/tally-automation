// test.js
import { utility } from "./utility.js";

export function test() {
  const testDate = "2013-01-01";
  const parsedDate = utility.Date.parse(testDate, "yyyy-MM-dd");
  console.log(parsedDate);
}
