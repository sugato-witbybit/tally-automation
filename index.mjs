import { utility } from "./utility.mjs";
import yaml from "yaml";
import fs from "fs";
import http from "http";

function createFieldXML(field, index, utility) {
  const fieldName = utility.Number.format(index + 1, "Fld00");
  let fieldXML = `<FIELD NAME="${fieldName}">`;

  const fieldTypeMap = {
    "text": `<SET>$${field.field}</SET>`,
    "logical": `<SET>if $${field.field} then 1 else 0</SET>`,
    "date": `<SET>if $$IsEmpty:$${field.field} then $$StrByCharCode:241 else $$PyrlYYYYMMDDFormat:$${field.field}:"-"</SET>`,
    "number": `<SET>if $$IsEmpty:$${field.field} then "0" else $$String:$${field.field}</SET>`,
    "amount": `<SET>$$StringFindAndReplace:(if $$IsDebit:$${field.field} then -$$NumValue:$${field.field} else $$NumValue:$${field.field}):"(-)":"-"</SET>`,
    "quantity": `<SET>$$StringFindAndReplace:(if $$IsInwards:$${field.field} then $$Number:$$String:$${field.field}:"TailUnits" else -$$Number:$$String:$${field.field}:"TailUnits"):"(-)":"-"</SET>`,
    "rate": `<SET>if $$IsEmpty:$${field.field} then 0 else $$Number:$${field.field}</SET>`
  };

  if (/^(\.\.)?[a-zA-Z0-9_]+$/g.test(field.field)) {
    fieldXML += fieldTypeMap[field.type] || `<SET>${field.field}</SET>`;
  } else {
    fieldXML += `<SET>${field.field}</SET>`;
  }

  fieldXML += `<XMLTAG>${utility.Number.format(index + 1, "F00")}</XMLTAG></FIELD>`;
  return fieldXML;
}

async function generateXMLfromYAML(tblConfig, config, utility) {
  let xmlHeader = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyReportLedgerTable</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>XML (Data Interchange)</SVEXPORTFORMAT><SVFROMDATE>{fromDate}</SVFROMDATE><SVTODATE>{toDate}</SVTODATE><SVCURRENTCOMPANY>{targetCompany}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyReportLedgerTable"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS></FORM>`;
  let xmlBody = "";
  
  xmlHeader = xmlHeader.replace("{targetCompany}", utility.String.escapeHTML(config.company));

  const lstRoutes = tblConfig.collection.split(/\./g);
  const targetCollection = lstRoutes.shift();
  lstRoutes.unshift("MyCollection");

  lstRoutes.forEach((route, i) => {
    const xmlPart = utility.Number.format(i + 1, "MyPart00");
    const xmlLine = utility.Number.format(i + 1, "MyLine00");
    xmlBody += `<PART NAME="${xmlPart}"><LINES>${xmlLine}</LINES><REPEAT>${xmlLine} : ${route}</REPEAT><SCROLLED>Vertical</SCROLLED></PART>`;
  });

  lstRoutes.slice(0, -1).forEach((_, i) => {
    const xmlLine = utility.Number.format(i + 1, "MyLine00");
    const xmlPart = utility.Number.format(i + 2, "MyPart00");
    xmlBody += `<LINE NAME="${xmlLine}"><FIELDS>FldBlank</FIELDS><EXPLODE>${xmlPart}</EXPLODE></LINE>`;
  });

  xmlBody += `<LINE NAME="${utility.Number.format(lstRoutes.length, "MyLine00")}"><FIELDS>`;

  tblConfig.fields.forEach((_, i) => {
    xmlBody += `${utility.Number.format(i + 1, "Fld00")},`;
  });
  xmlBody = utility.String.strip(xmlBody) + `</FIELDS></LINE>`;

  tblConfig.fields.forEach((field, i) => {
    const fieldXML = createFieldXML(field, i, utility);
    xmlBody += fieldXML;
  });

  xmlBody += `<FIELD NAME="FldBlank"><SET>""</SET></FIELD>`;

  xmlBody += `<COLLECTION NAME="MyCollection"><TYPE>${targetCollection}</TYPE>`;
  if (tblConfig.fetch?.length) xmlBody += `<FETCH>${tblConfig.fetch.join(",")}</FETCH>`;

  if (tblConfig.filters?.length) {
    xmlBody += `<FILTER>${tblConfig.filters.map((_, j) => utility.Number.format(j + 1, "Fltr00")).join(",")}</FILTER>`;
  }
  
  xmlBody += `</COLLECTION>`;

  tblConfig.filters?.forEach((filter, j) => {
    xmlBody += `<SYSTEM TYPE="Formulae" NAME="${utility.Number.format(j + 1, "Fltr00")}">${filter}</SYSTEM>`;
  });

  const xmlFooter = `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  return xmlHeader + xmlBody + xmlFooter;
}

function substituteTDLParameters(msg, substitutions, utility) {
  substitutions.forEach((value, key) => {
    let regExp = new RegExp(`\\{${key}\\}`, "g");
    msg = msg.replace(
      regExp,
      typeof value === "string"
        ? utility.String.escapeHTML(value)
        : value.toString()
    );
  });
  return msg;
}

function postTallyXML(msg, serverConfig) {
  return new Promise((resolve, reject) => {
    try {
      const req = http.request(
        {
          hostname: serverConfig.server,
          port: serverConfig.port,
          path: "",
          method: "POST",
          headers: {
            "Content-Length": Buffer.byteLength(msg, "utf16le"),
            "Content-Type": "text/xml;charset=utf-16",
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf16le");

          res.on("data", (chunk) => {
            let result = chunk.toString() || "";
            data += result;
          });

          res.on("end", () => {
            resolve(data);
          });

          res.on("error", (httpErr) => {
            console.error("Response Error:", httpErr.message);
            reject(new Error(`Response error: ${httpErr.message}`));
          });
        }
      );

      req.on("error", (reqError) => {
        console.error("Request Error:", reqError.message);
        reject(new Error(`postTallyXML() error: ${reqError.message}`));
      });

      req.write(msg, "utf16le");
      req.end();
    } catch (err) {
      console.error("Post Tally XML Error:", err);
      reject(new Error(`postTallyXML() error: ${err.message}`));
    }
  });
}

function processTdlOutputManipulation(txt) {
  return txt
    .replace("<ENVELOPE>", "")
    .replace("</ENVELOPE>", "")
    .replace(/\<FLDBLANK\>\<\/FLDBLANK\>/g, "")
    .replace(/\s+\r\n/g, "")
    .replace(/\r\n/g, "")
    .replace(/\t/g, " ")
    .replace(/\s+\<F/g, "<F")
    .replace(/\<\/F\d+\>/g, "")
    .replace(/\<F01\>/g, "\r\n")
    .replace(/\<F\d+\>/g, "\t")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function processReport(targetTable, tableConfig, substitutions, config) {
  try {
    let xml = await generateXMLfromYAML(tableConfig, config, utility);

    if (substitutions && substitutions.size) {
      xml = await substituteTDLParameters(xml, substitutions, utility);
    }

    let output = await postTallyXML(xml, config);
    output = await processTdlOutputManipulation(output);

    const columnHeaders = tableConfig.fields.map((field) => field.name).join("\t");
    const fullOutput = columnHeaders + output;
    const rows = fullOutput.split("\r\n");

    const headers = tableConfig.fields.map((field) => field.name);
    const jsonContent = rows.map((row) => {
      const values = row.split("\t");
      const rowObject = headers.reduce((obj, header, idx) => {
        obj[header] = values[idx];
        return obj;
      }, {});
      return rowObject;
    });

    return jsonContent;
  } catch (err) {
    throw new Error(`processReport(${targetTable}) error: ${err.message}`);
  }
}

async function app() {
  try {
    const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
    const importMaster = true;
    const importTransaction = true;

    const tallyPathExportDefinition = config.definition;
    if (fs.existsSync(`./${tallyPathExportDefinition}`)) {
      const objYAML = yaml.parse(
        fs.readFileSync(`./${tallyPathExportDefinition}`, "utf-8")
      );
      config.lstTableMaster = objYAML["master"];
      config.lstTableTransaction = objYAML["transaction"];
    } else {
      return {
        status: "error",
        message: "Tally export definition file does not exist or is invalid.",
      };
    }

    const lstTables = [
      ...(importMaster ? config.lstTableMaster : []),
      ...(importTransaction ? config.lstTableTransaction : [])
    ];

    const configTallyXML = new Map([
      ["fromDate", utility.Date.parse(config.fromDate, "yyyy-MM-dd")],
      ["toDate", utility.Date.parse(config.toDate, "yyyy-MM-dd")],
      [
        "targetCompany",
        config.company
          ? utility.String.escapeHTML(config.company)
          : "##SVCurrentCompany"
      ]
    ]);

    const jsonData = {};

    for (const tableConfig of lstTables) {
      const targetTable = tableConfig.name;
      try {
        const jsonContent = await processReport(
          targetTable,
          tableConfig,
          configTallyXML,
          config
        );
        jsonData[targetTable] = jsonContent;
      } catch (err) {
        console.error(`Error processing report for ${targetTable}:`, err.message);
      }
    }

    const filterLedger = (data, parentValue) => ({
      data: data.filter((item) => item.parent === parentValue)
    });

    const newData = filterLedger(jsonData["mst_ledger"], "Sundry Debtors");
    fs.writeFileSync("./data.json", JSON.stringify(newData, null, 2), "utf-8");

    return {
      status: "success",
      message: "Data retrieved successfully",
    };
  } catch (err) {
    return {
      status: "error",
      message: "An error occurred while processing the request.",
      error: err.message,
    };
  }
}

app();
